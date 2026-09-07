import { randomUUID } from 'node:crypto';
import { Database, enqueue, type Tx } from './db.js';
import { AppError, assertNotExpired, assertTransition, hashJson, hbar, hcsEventSchema, tinybars, type Status, type TaskSpec } from './domain.js';
import type { Ledger } from './hedera.js';
import { validateImage, type Storage } from './storage.js';
import type { Config } from './config.js';
import type { z } from 'zod';
import type { evidenceInput, uploadsInput } from './domain.js';

export type Principal = { id: string; role: 'agent' | 'worker' | 'operator' };
export type Reply = { status: number; body: any };
export async function taskEvent(tx: Tx, taskId: string, type: string, data: unknown = {}): Promise<void> {
  await tx.query('INSERT INTO task_events(task_id,type,data) VALUES ($1,$2,$3)', [taskId, type, JSON.stringify(data)]);
}
export async function transition(tx: Tx, task: any, status: Status): Promise<void> {
  assertTransition(task.status, status);
  await tx.query('UPDATE tasks SET status=$2, updated_at=now(), reserved=CASE WHEN $2 IN (\'PAID\',\'REJECTED\',\'MANUAL_REVIEW\',\'CANCELLED\',\'EXPIRED\') THEN false ELSE reserved END WHERE id=$1', [task.id, status]);
  await taskEvent(tx, task.id, status); task.status = status;
}
export async function queueHcs(tx: Tx, taskId: string, data: Record<string, unknown>): Promise<void> {
  const id = randomUUID();
  const payload = hcsEventSchema.parse({ version: 1, ...data, eventId: id, taskId, timestamp: new Date().toISOString() });
  await tx.query('INSERT INTO hcs_events(id,task_id,type,payload) VALUES ($1,$2,$3,$4) ON CONFLICT (task_id,type) DO NOTHING', [id, taskId, payload.type, JSON.stringify(payload)]);
  await enqueue(tx, 'hcs', taskId, `hcs:${taskId}:${payload.type}`, { type: payload.type });
}
export class Marketplace {
  constructor(readonly db: Database, readonly ledger: Ledger, readonly storage: Storage, readonly config: Config) {}
  async idempotent(principal: Principal, scope: string, key: string, body: unknown, action: (tx: Tx) => Promise<Reply>): Promise<Reply> {
    const fingerprint = hashJson(body);
    return this.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`idem:${principal.id}:${scope}:${key}`]);
      const old = (await tx.query('SELECT * FROM idempotency WHERE principal_id=$1 AND scope=$2 AND key=$3', [principal.id, scope, key])).rows[0];
      if (old) {
        if (old.request_hash !== fingerprint) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different body');
        return { status: old.response_status, body: old.response_body };
      }
      const response = await action(tx);
      await tx.query('INSERT INTO idempotency(principal_id,scope,key,request_hash,response_status,response_body) VALUES ($1,$2,$3,$4,$5,$6)', [principal.id, scope, key, fingerprint, response.status, JSON.stringify(response.body)]);
      return response;
    });
  }
  async lockedTask(tx: Tx, taskId: string): Promise<any> {
    const task = (await tx.query('SELECT * FROM tasks WHERE id=$1 FOR NO KEY UPDATE', [taskId])).rows[0];
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'Task not found'); return task;
  }
  async ownedClaim(tx: Tx, taskId: string, principal: Principal): Promise<any> {
    const claim = (await tx.query('SELECT * FROM claims WHERE task_id=$1 AND worker_id=$2', [taskId, principal.id])).rows[0];
    if (!claim) throw new AppError(403, 'CLAIM_REQUIRED', 'Task belongs to another collaborator'); return claim;
  }
  async create(tx: Tx, principal: Principal, spec: TaskSpec): Promise<Reply> {
    assertNotExpired(spec.expiresAt);
    // Serialize allocation with reward submission so a confirmed debit cannot also be counted as available.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('reward-budget'))");
    const balance = await this.ledger.balance();
    const reserved = (await tx.query('SELECT COALESCE(sum(reward_tinybars),0)::text AS total FROM tasks WHERE reserved')).rows[0].total;
    if (balance - BigInt(reserved) - tinybars(this.config.HEDERA_FEE_RESERVE_HBAR) < tinybars(spec.reward.amount)) throw new AppError(409, 'INSUFFICIENT_REWARD_BUDGET', 'Operator balance cannot cover this reward and existing reservations');
    const id = randomUUID(); const normalized = { ...spec, expiresAt: new Date(spec.expiresAt).toISOString(), reward: { asset: 'HBAR', amount: hbar(tinybars(spec.reward.amount)) }, verificationPriceLimit: { asset: 'HBAR', amount: hbar(tinybars(spec.verificationPriceLimit.amount)) } };
    const committedSpec = { ...normalized, verificationPaymentMode: this.config.VERIFICATION_PAYMENT_MODE };
    const specHash = hashJson(committedSpec);
    await tx.query('INSERT INTO tasks(id,agent_id,status,spec,spec_hash,reward_tinybars,expires_at,verification_payment_mode) VALUES ($1,$2,\'DRAFT\',$3,$4,$5,$6,$7)', [id, principal.id, JSON.stringify(committedSpec), specHash, tinybars(spec.reward.amount).toString(), spec.expiresAt, this.config.VERIFICATION_PAYMENT_MODE]);
    await taskEvent(tx, id, 'DRAFT');
    await queueHcs(tx, id, { type: 'TaskCreated', taskSpecHash: specHash, rewardAsset: 'HBAR', rewardAmount: normalized.reward.amount, expiresAt: normalized.expiresAt, policyVersion: spec.policyVersion });
    return { status: 202, body: { id, status: 'DRAFT', taskSpecHash: specHash } };
  }
  async payout(tx: Tx, principal: Principal, workerId: string, account: string): Promise<Reply> {
    if (principal.id !== workerId) throw new AppError(403, 'FORBIDDEN', 'Only your own payout account can be changed');
    if (account === this.ledger.operatorId) throw new AppError(400, 'INVALID_PAYOUT_ACCOUNT', 'Use a collaborator account different from the operator');
    if (!await this.ledger.accountExists(account)) throw new AppError(400, 'ACCOUNT_NOT_FOUND', 'Hedera testnet account does not exist or is deleted');
    const row = (await tx.query('UPDATE workers SET payout_account_id=$2, verified_at=now() WHERE id=$1 RETURNING *', [workerId, account])).rows[0];
    if (!row) throw new AppError(404, 'WORKER_NOT_FOUND', 'Worker not found');
    return { status: 200, body: { workerId, payoutAccountId: account, verifiedAt: row.verified_at.toISOString() } };
  }
  async claim(tx: Tx, principal: Principal, taskId: string): Promise<Reply> {
    const task = await this.lockedTask(tx, taskId); assertNotExpired(task.expires_at);
    assertTransition(task.status, 'CLAIMED');
    const worker = (await tx.query('SELECT * FROM workers WHERE id=$1 FOR UPDATE', [principal.id])).rows[0];
    if (!worker?.payout_account_id) throw new AppError(409, 'PAYOUT_ACCOUNT_REQUIRED', 'Configure a payout account before claiming');
    if (!await this.ledger.accountExists(worker.payout_account_id)) throw new AppError(400, 'ACCOUNT_NOT_FOUND', 'Payout account no longer exists');
    await tx.query('INSERT INTO claims(task_id,worker_id,payout_account_id,expires_at) VALUES ($1,$2,$3,$4)', [taskId, principal.id, worker.payout_account_id, task.expires_at]);
    await transition(tx, task, 'CLAIMED');
    return { status: 200, body: { taskId, status: 'CLAIMED', payoutAccountId: worker.payout_account_id, expiresAt: task.expires_at.toISOString() } };
  }
  async cancel(tx: Tx, principal: Principal, taskId: string): Promise<Reply> {
    const task = await this.lockedTask(tx, taskId);
    if (task.agent_id !== principal.id) throw new AppError(403, 'FORBIDDEN', 'Only the task owner can cancel it');
    assertNotExpired(task.expires_at); await transition(tx, task, 'CANCELLED'); return { status: 200, body: { taskId, status: 'CANCELLED' } };
  }
  async uploads(tx: Tx, principal: Principal, taskId: string, input: z.infer<typeof uploadsInput>): Promise<Reply> {
    const task = await this.lockedTask(tx, taskId); await this.ownedClaim(tx, taskId, principal); assertNotExpired(task.expires_at);
    if (task.status !== 'CLAIMED') throw new AppError(409, 'INVALID_STATE', 'Uploads require a claimed task');
    if (new Set(input.files.map(f => f.type)).size !== 2) throw new AppError(400, 'EVIDENCE_TYPES_REQUIRED', 'Supply both evidence types');
    const files = [];
    for (const file of input.files) {
      const id = randomUUID(), key = `uploads/${taskId}/${id}.jpg`, expiresAt = new Date(Date.now() + 300_000);
      await tx.query('INSERT INTO uploads(id,task_id,worker_id,type,sha256,byte_size,storage_key,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, taskId, principal.id, file.type, file.sha256, file.size, key, expiresAt]);
      files.push({ uploadId: id, type: file.type, method: 'PUT', url: await this.storage.uploadUrl(key), headers: { 'Content-Type': 'image/jpeg' }, expiresAt: expiresAt.toISOString() });
    }
    return { status: 201, body: { files } };
  }
  async submit(tx: Tx, principal: Principal, taskId: string, input: z.infer<typeof evidenceInput>): Promise<Reply> {
    const task = await this.lockedTask(tx, taskId); await this.ownedClaim(tx, taskId, principal); assertNotExpired(task.expires_at);
    assertTransition(task.status, 'EVIDENCE_SUBMITTED');
    if (new Set(input.files.map(f => f.type)).size !== 2) throw new AppError(400, 'EVIDENCE_TYPES_REQUIRED', 'Supply both evidence types');
    const files = [];
    for (const file of [...input.files].sort((a,b) => a.type.localeCompare(b.type))) {
      const upload = (await tx.query('SELECT * FROM uploads WHERE id=$1 AND task_id=$2 AND worker_id=$3 AND deleted_at IS NULL', [file.uploadId, taskId, principal.id])).rows[0];
      if (!upload || upload.type !== file.type || upload.sha256 !== file.sha256) throw new AppError(400, 'INVALID_UPLOAD', 'Upload does not match this claim, type and hash');
      let bytes: Buffer;
      try { bytes = await this.storage.read(upload.storage_key); } catch (e: any) { if (e.name === 'NoSuchKey') throw new AppError(400, 'UPLOAD_MISSING', 'Upload the image before submitting evidence'); throw e; }
      await validateImage(bytes, file.sha256, upload.byte_size);
      // Content-addressed destination has no client write URL. A retry writes identical verified bytes.
      const storageKey = `private/${taskId}/${file.type}-${file.sha256.slice(7)}.jpg`;
      // Independent journal survives a rollback after writing S3, so orphan bytes can be removed.
      await this.db.query('INSERT INTO private_objects(storage_key,task_id) VALUES ($1,$2) ON CONFLICT (storage_key) DO UPDATE SET deleted_at=NULL', [storageKey, taskId]);
      await this.storage.write(storageKey, bytes);
      files.push({ type: file.type, sha256: file.sha256, storageKey });
    }
    // Hash comparisons and insert are serialized across tasks, preventing concurrent reuse from bypassing detection.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('evidence-history'))");
    const duplicate = new Set(files.map(f => f.sha256)).size !== files.length || !!(await tx.query('SELECT 1 FROM evidence_files WHERE sha256=ANY($1::text[]) LIMIT 1', [files.map(f => f.sha256)])).rowCount;
    assertNotExpired(task.expires_at);
    const manifest = { taskId, qrHash: input.qrHash, answers: input.answers, files: files.map(({ type, sha256 }) => ({ type, sha256 })) };
    const aggregateHash = hashJson(manifest);
    await tx.query('INSERT INTO evidence(task_id,manifest,aggregate_hash,exact_duplicate) VALUES ($1,$2,$3,$4)', [taskId, JSON.stringify(manifest), aggregateHash, duplicate]);
    for (const file of files) await tx.query('INSERT INTO evidence_files(task_id,type,sha256,storage_key) VALUES ($1,$2,$3,$4)', [taskId, file.type, file.sha256, file.storageKey]);
    await transition(tx, task, 'EVIDENCE_SUBMITTED');
    await queueHcs(tx, taskId, { type: 'EvidenceSubmitted', evidenceAggregateHash: aggregateHash });
    await tx.query('INSERT INTO verifications(task_id,operation_id,scenario) VALUES ($1,$2,$3)', [taskId, randomUUID(), this.config.MOCK_VERIFIER_SCENARIO]);
    return { status: 202, body: { taskId, status: 'EVIDENCE_SUBMITTED', evidenceAggregateHash: aggregateHash, verificationMode: 'mock', x402PaymentStatus: task.verification_payment_mode === 'x402' ? 'awaiting_payment' : 'not_performed' } };
  }
  async authorizeRead(principal: Principal, taskId: string): Promise<any> {
    const task = (await this.db.query('SELECT t.*, c.worker_id FROM tasks t LEFT JOIN claims c ON c.task_id=t.id WHERE t.id=$1', [taskId]))[0];
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'Task not found');
    if (principal.role !== 'operator' && task.agent_id !== principal.id && task.worker_id !== principal.id) throw new AppError(403, 'FORBIDDEN', 'Private task data requires ownership or an active claim');
    return task;
  }
  summary(task: any): any {
    const { title, instructions, assetExternalId, requiredEvidence, reward, verificationPriceLimit, policyVersion } = task.spec;
    return { id: task.id, status: task.status, title, instructions, assetExternalId, requiredEvidence, reward, verificationPriceLimit, policyVersion, verificationPaymentMode: task.verification_payment_mode, expiresAt: task.expires_at.toISOString() };
  }
  async detail(principal: Principal, taskId: string): Promise<any> {
    const row = (await this.db.query('SELECT t.*, c.worker_id FROM tasks t LEFT JOIN claims c ON c.task_id=t.id WHERE t.id=$1', [taskId]))[0];
    if (!row) throw new AppError(404, 'TASK_NOT_FOUND', 'Task not found');
    const privateAccess = principal.role === 'operator' || row.agent_id === principal.id || row.worker_id === principal.id;
    if (!privateAccess) {
      if (row.status !== 'OPEN' || row.expires_at <= new Date()) throw new AppError(403, 'FORBIDDEN', 'Task is not available');
      return this.summary(row);
    }
    const verifications = await this.db.query('SELECT status, mode, last_error, attempts FROM verifications WHERE task_id=$1', [taskId]);
    const operations = await this.db.query('SELECT status, transaction_id FROM economic_operations WHERE task_id=$1', [taskId]);
    const hcs = await this.db.query('SELECT type,status,sequence,transaction_id FROM hcs_events WHERE task_id=$1 ORDER BY created_at', [taskId]);
    const payment = (await this.db.query('SELECT id,status,transaction_id AS "transactionId" FROM verification_payments WHERE task_id=$1', [taskId]))[0];
    return { ...this.summary(row), expectedQrHash: row.spec.expectedQrHash, taskSpecHash: row.spec_hash, verification: verifications[0] ?? null, rewardOperation: operations[0] ?? null, hcs, verificationMode: 'mock', x402PaymentStatus: payment?.status.toLowerCase() ?? (row.verification_payment_mode === 'x402' ? 'awaiting_payment' : 'not_performed'), verificationPayment: payment ?? null };
  }
}
