import { randomUUID } from 'node:crypto';
import { Database, enqueue } from './db.js';
import { hcsEventSchema, sha256 } from './domain.js';
import type { Ledger, Prepared } from './hedera.js';
import { Marketplace, queueHcs, transition, taskEvent } from './service.js';
import { resultSchema, type VerifierAdapter } from './verifier.js';
import { Payments } from './payments.js';

export class Processor {
  constructor(private service: Marketplace, private verifier: VerifierAdapter, private payments = new Payments(service)) {}
  get db(): Database { return this.service.db; }
  get ledger(): Ledger { return this.service.ledger; }
  async tick(): Promise<boolean> {
    const lock = await this.db.pool.connect();
    let id: string | undefined;
    try {
      const jobs = (await lock.query("SELECT id FROM jobs WHERE status='PENDING' AND available_at<=now() ORDER BY id LIMIT 20")).rows;
      for (const job of jobs) {
        if ((await lock.query('SELECT pg_try_advisory_lock(402, $1::integer) AS acquired', [job.id])).rows[0].acquired) { id = job.id; break; }
      }
      if (!id) return false;
      const job = (await lock.query("UPDATE jobs SET attempts=attempts+1 WHERE id=$1 AND status='PENDING' AND available_at<=now() RETURNING *", [id])).rows[0];
      if (!job) return false;
      try {
        if (job.kind === 'hcs') await this.hcs(job.task_id, job.payload.type);
        else if (job.kind === 'verify') await this.verify(job.task_id);
        else if (job.kind === 'reward') await this.reward(job.task_id);
        else if (job.kind === 'x402_settle') await this.payments.settle(job.task_id);
        else throw new Error('UNKNOWN_JOB_KIND');
        await lock.query("UPDATE jobs SET status='DONE',finished_at=now(),last_error=NULL WHERE id=$1", [id]);
      } catch (error: any) {
        // Persist a bounded safe error code; SDK error messages may contain transaction material.
        const code = /^[A-Z_]{3,80}$/.test(error.message) ? error.message : 'EXTERNAL_OPERATION_RETRY';
        await lock.query("UPDATE jobs SET status=$2,last_error=$3,available_at=now()+($4::integer * interval '1 second') WHERE id=$1", [id, job.attempts >= 10 ? 'BLOCKED' : 'PENDING', code, Math.min(300, 2 ** job.attempts)]);
        if (job.kind === 'verify') await this.db.query("UPDATE verifications SET last_error=$2, status=CASE WHEN status='COMPLETED' THEN status ELSE 'RETRYING' END WHERE task_id=$1", [job.task_id, code]);
      }
      return true;
    } finally {
      if (id) await lock.query('SELECT pg_advisory_unlock(402,$1::integer)', [id]);
      lock.release();
    }
  }
  private async executePrepared(table: 'hcs_events' | 'economic_operations', row: any, prepare: () => Promise<Prepared>): Promise<{ sequence?: string }> {
    if (row.status === 'CONFIRMED') return { sequence: row.sequence };
    if (row.status === 'FAILED') throw new Error('LEDGER_OPERATION_FAILED');
    const fresh = !row.transaction_id;
    if (fresh) {
      const prepared = await prepare();
      await this.db.query(`UPDATE ${table} SET transaction_id=$2,signed_bytes=$3,status='PREPARED' WHERE id=$1`, [row.id, prepared.transactionId, prepared.bytes]);
      row.transaction_id = prepared.transactionId; row.signed_bytes = prepared.bytes;
    }
    let confirmation = fresh ? { status: 'PENDING' as const } : await this.ledger.confirm(row.transaction_id);
    if (confirmation.status === 'PENDING') {
      // Replay only the exact frozen transaction. An expired or ambiguous ID is never replaced automatically.
      try { await this.ledger.submit(row.signed_bytes); } catch { /* Reconcile a timeout or duplicate submission below. */ }
      confirmation = await this.ledger.confirm(row.transaction_id);
    }
    if (confirmation.status === 'FAILED') {
      await this.db.query(`UPDATE ${table} SET status='FAILED',last_error=$2 WHERE id=$1`, [row.id, confirmation.reason ?? 'LEDGER_FAILURE']);
      throw new Error('LEDGER_OPERATION_FAILED');
    }
    if (confirmation.status !== 'SUCCESS') throw new Error('PENDING_LEDGER_CONFIRMATION');
    // The caller commits confirmation and its resulting domain transition atomically.
    return { sequence: confirmation.sequence };
  }
  private async hcs(taskId: string, type: string): Promise<void> {
    const row = (await this.db.query('SELECT * FROM hcs_events WHERE task_id=$1 AND type=$2', [taskId, type]))[0];
    if (!row) throw new Error('HCS_EVENT_MISSING');
    const confirmation = await this.executePrepared('hcs_events', row, () => this.ledger.prepareMessage(hcsEventSchema.parse(row.payload)));
    if (!confirmation.sequence) throw new Error('PENDING_HCS_SEQUENCE');
    await this.db.transaction(async tx => {
      const task = await this.service.lockedTask(tx, taskId);
      const current = (await tx.query('SELECT * FROM hcs_events WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
      if (current.status === 'CONFIRMED') return;
      await tx.query("UPDATE hcs_events SET status='CONFIRMED',sequence=$2,last_error=NULL WHERE id=$1", [row.id, confirmation.sequence]);
      await taskEvent(tx, taskId, 'HCS_CONFIRMED', { type, sequence: confirmation.sequence, transactionId: row.transaction_id });
      if (type === 'TaskCreated') {
        await transition(tx, task, 'OPEN');
        if (task.expires_at <= new Date()) await transition(tx, task, 'EXPIRED');
      } else if (type === 'EvidenceSubmitted') {
        if (task.verification_payment_mode === 'free_mock') {
          await transition(tx, task, 'VERIFYING');
          await enqueue(tx, 'verify', taskId, `verify:${taskId}`);
        } else await taskEvent(tx, taskId, 'AWAITING_VERIFICATION_PAYMENT');
      } else if (type === 'VerificationCompleted' && task.status === 'APPROVED') {
        const claim = (await tx.query('SELECT * FROM claims WHERE task_id=$1', [taskId])).rows[0];
        await tx.query("INSERT INTO economic_operations(id,task_id,type,idempotency_key,amount_tinybars,recipient) VALUES ($1,$2,'WORKER_REWARD',$3,$4,$5) ON CONFLICT (task_id) DO NOTHING", [randomUUID(), taskId, `reward:${taskId}:v1`, task.reward_tinybars, claim.payout_account_id]);
        await enqueue(tx, 'reward', taskId, `reward:${taskId}`);
      }
    });
  }
  private async verify(taskId: string): Promise<void> {
    const task = (await this.db.query('SELECT * FROM tasks WHERE id=$1', [taskId]))[0];
    const payment = (await this.db.query('SELECT status,transaction_id FROM verification_payments WHERE task_id=$1', [taskId]))[0];
    if (task.verification_payment_mode === 'x402' && payment?.status !== 'CONFIRMED') throw new Error('VERIFICATION_REQUIRES_PAYMENT');
    const verification = (await this.db.query('UPDATE verifications SET attempts=attempts+1,updated_at=now() WHERE task_id=$1 RETURNING *', [taskId]))[0];
    if (verification.result) return;
    const evidence = (await this.db.query('SELECT * FROM evidence WHERE task_id=$1', [taskId]))[0];
    const analysis = await this.verifier.recover({ operationId: verification.operation_id, taskId, scenario: verification.scenario, attempt: verification.attempts - 1,
      evidenceAggregateHash: evidence.aggregate_hash,
      checks: { qrMatches: task.spec.expectedQrHash === evidence.manifest.qrHash, requiredFilesPresent: evidence.manifest.files.length === 2, exactDuplicateDetected: evidence.exact_duplicate, imageReadable: true, answerConsistent: true },
    });
    const result = resultSchema.parse({ ...analysis, x402PaymentReference: payment?.transaction_id ?? null });
    if (result.taskId !== taskId || result.evidenceAggregateHash !== evidence.aggregate_hash) throw new Error('VERIFIER_RESULT_MISMATCH');
    await this.db.transaction(async tx => {
      const locked = await this.service.lockedTask(tx, taskId);
      if (locked.status !== 'VERIFYING') throw new Error('VERIFICATION_STATE_MISMATCH');
      await tx.query("UPDATE verifications SET result=$2,status='COMPLETED',last_error=NULL,updated_at=now() WHERE task_id=$1", [taskId, JSON.stringify(result)]);
      await transition(tx, locked, result.status);
      await queueHcs(tx, taskId, { type: 'VerificationCompleted', evidenceAggregateHash: result.evidenceAggregateHash, result: result.status, verifierVersion: result.verifierVersion, verificationMode: result.verificationMode,
        ...(result.x402PaymentReference ? { version: 2, x402PaymentReferenceHash: sha256(result.x402PaymentReference) } : {}),
      });
    });
  }
  private async reward(taskId: string): Promise<void> {
    // A session lock spans the ledger call and confirmation commit. Budget allocation uses the same key.
    const lock = await this.db.pool.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtext('reward-budget'))");
      const row = (await this.db.query('SELECT * FROM economic_operations WHERE task_id=$1', [taskId]))[0];
      const task = (await this.db.query('SELECT * FROM tasks WHERE id=$1', [taskId]))[0];
      if (task.status === 'PAID' && row.status === 'CONFIRMED') return;
      if (task.status !== 'APPROVED') throw new Error('REWARD_REQUIRES_APPROVAL');
      await this.executePrepared('economic_operations', row, () => this.ledger.prepareReward(taskId, row.recipient, row.amount_tinybars));
      await this.db.transaction(async tx => {
        const current = await this.service.lockedTask(tx, taskId);
        await tx.query("UPDATE economic_operations SET status='CONFIRMED',confirmed_at=now(),last_error=NULL WHERE id=$1", [row.id]);
        await transition(tx, current, 'PAID');
        await queueHcs(tx, taskId, { type: 'RewardPaid', asset: 'HBAR', amount: task.spec.reward.amount, rewardTransactionReferenceHash: sha256(row.transaction_id) });
      });
    } finally { await lock.query("SELECT pg_advisory_unlock(hashtext('reward-budget'))"); lock.release(); }
  }
  async maintain(): Promise<void> {
    await this.db.transaction(async tx => {
      const tasks = (await tx.query("SELECT * FROM tasks WHERE status IN ('OPEN','CLAIMED') AND expires_at<=now() FOR UPDATE SKIP LOCKED")).rows;
      for (const task of tasks) await transition(tx, task, 'EXPIRED');
    });
    const uploads = await this.db.query("SELECT * FROM uploads WHERE deleted_at IS NULL AND created_at < now()-interval '24 hours' LIMIT 100");
    for (const upload of uploads) {
      await this.service.storage.delete(upload.storage_key);
      await this.db.query('UPDATE uploads SET deleted_at=now() WHERE id=$1', [upload.id]);
    }
    const evidence = await this.db.query("SELECT e.task_id FROM evidence e WHERE e.deleted_at IS NULL AND e.delete_after<=now() AND NOT EXISTS (SELECT 1 FROM verification_payments p JOIN verifications v ON v.operation_id=p.verification_id WHERE p.task_id=e.task_id AND p.payment_payload IS NOT NULL AND p.status<>'FAILED' AND v.status<>'COMPLETED') LIMIT 100");
    for (const item of evidence) {
      const files = await this.db.query('SELECT storage_key FROM evidence_files WHERE task_id=$1', [item.task_id]);
      for (const file of files) await this.service.storage.delete(file.storage_key);
      await this.db.query('UPDATE evidence SET deleted_at=now() WHERE task_id=$1', [item.task_id]);
      await this.db.query('UPDATE private_objects SET deleted_at=now() WHERE task_id=$1', [item.task_id]);
    }
    const orphans = await this.db.query("SELECT o.storage_key FROM private_objects o WHERE o.deleted_at IS NULL AND o.created_at < now()-interval '24 hours' AND NOT EXISTS (SELECT 1 FROM evidence_files f WHERE f.storage_key=o.storage_key) LIMIT 100");
    for (const orphan of orphans) {
      await this.db.transaction(async tx => {
        const journal = (await tx.query('SELECT task_id FROM private_objects WHERE storage_key=$1', [orphan.storage_key])).rows[0];
        await this.service.lockedTask(tx, journal.task_id);
        // Recheck after serializing against submission; an old orphan may now be committed evidence.
        const eligible = (await tx.query("SELECT 1 FROM private_objects o WHERE o.storage_key=$1 AND o.deleted_at IS NULL AND o.created_at < now()-interval '24 hours' AND NOT EXISTS (SELECT 1 FROM evidence_files f WHERE f.storage_key=o.storage_key)", [orphan.storage_key])).rowCount;
        if (!eligible) return;
        await this.service.storage.delete(orphan.storage_key);
        await tx.query('UPDATE private_objects SET deleted_at=now() WHERE storage_key=$1', [orphan.storage_key]);
      });
    }
  }
}
