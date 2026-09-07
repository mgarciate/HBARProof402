import { randomUUID } from 'node:crypto';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired, SettleResponse } from '@x402/core/types';
import { AppError, hashJson, sha256, tinybars, transactionUrl } from './domain.js';
import { enqueue } from './db.js';
import { type Marketplace, type Principal, taskEvent, transition } from './service.js';
import { Blocky402Facilitator, decodeAuthorization, inspectAuthorization, matchesPaymentTransfer, requirementsSchema, type Facilitator } from './x402-protocol.js';

export type PaymentReply = { status: number; body: any; headers?: Record<string, string> };
export class Payments {
  constructor(readonly service: Marketplace, readonly facilitator: Facilitator = new Blocky402Facilitator()) {}

  private view(row: any) {
    return { id: row.id, taskId: row.task_id, status: row.status, amountTinybars: row.amount_tinybars, recipient: row.recipient,
      evidenceAggregateHash: row.evidence_hash, transactionId: row.transaction_id, operationalError: row.last_error,
      hashscanUrl: row.transaction_id ? transactionUrl(row.transaction_id) : null,
      statusUrl: `/v1/x402/payments/${row.id}`, resultUrl: `/v1/tasks/${row.task_id}/result`, verificationMode: 'mock' };
  }
  private challenge(row: any, error?: string): PaymentReply {
    const challenge: PaymentRequired = { x402Version: 2, resource: row.resource, accepts: [row.requirements], ...(error ? { error } : {}) };
    return { status: 402, body: { ...challenge, purchase: { ...this.view(row), quoteExpiresAt: row.quoted_until.toISOString() } },
      headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge), 'Cache-Control': 'no-store' } };
  }
  async purchase(principal: Principal, taskId: string, key: string, signature?: string): Promise<PaymentReply> {
    if (principal.role !== 'agent') throw new AppError(403, 'FORBIDDEN', 'Only the requesting agent can buy verification');
    const fingerprint = hashJson({ taskId });
    const payload = signature ? decodeAuthorization(signature) : undefined;
    return this.service.db.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`purchase:${principal.id}:${key}`]);
      const existingKey = (await tx.query('SELECT * FROM verification_payment_keys WHERE principal_id=$1 AND key=$2', [principal.id, key])).rows[0];
      if (existingKey && existingKey.request_hash !== fingerprint) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Purchase key already belongs to another task');
      const task = await this.service.lockedTask(tx, taskId);
      if (task.agent_id !== principal.id) throw new AppError(403, 'FORBIDDEN', 'Only the task owner can buy verification');
      if (task.verification_payment_mode !== 'x402') throw new AppError(409, 'PAYMENT_NOT_REQUIRED', 'This task uses the legacy free mock workflow');
      let payment = (await tx.query('SELECT * FROM verification_payments WHERE task_id=$1 FOR UPDATE', [taskId])).rows[0];
      if (payment?.payment_payload) {
        if (!existingKey) await tx.query('INSERT INTO verification_payment_keys(principal_id,key,request_hash,payment_id) VALUES ($1,$2,$3,$4)', [principal.id, key, fingerprint, payment.id]);
        if (payload && payment.authorization_hash !== hashJson(payload)) throw new AppError(409, 'PAYMENT_ALREADY_AUTHORIZED', 'Recover the original purchase; do not sign another payment');
        const result = (await tx.query('SELECT result FROM verifications WHERE task_id=$1', [taskId])).rows[0]?.result;
        return { status: result ? 200 : 202, body: { ...this.view(payment), result: result ?? null }, headers: payment.status === 'CONFIRMED' ? { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(payment.settlement) } : {} };
      }
      if (task.status !== 'EVIDENCE_SUBMITTED') throw new AppError(409, 'EVIDENCE_NOT_READY', 'Verification requires submitted evidence');
      const evidence = (await tx.query('SELECT * FROM evidence WHERE task_id=$1', [taskId])).rows[0];
      const committed = (await tx.query("SELECT 1 FROM hcs_events WHERE task_id=$1 AND type='EvidenceSubmitted' AND status='CONFIRMED'", [taskId])).rowCount;
      if (!committed) throw new AppError(409, 'EVIDENCE_NOT_COMMITTED', 'Wait for the evidence HCS commitment');
      if (!evidence || evidence.deleted_at || new Date(evidence.delete_after).getTime() <= Date.now() + 300_000) throw new AppError(409, 'EVIDENCE_UNAVAILABLE', 'Evidence is missing or too close to retention expiry');
      const files = (await tx.query('SELECT sha256,storage_key FROM evidence_files WHERE task_id=$1', [taskId])).rows;
      if (files.length !== 2) throw new AppError(409, 'EVIDENCE_UNAVAILABLE', 'Required evidence is unavailable');
      for (const file of files) {
        try {
          if (sha256(await this.service.storage.read(file.storage_key)) !== file.sha256) throw new Error('Mismatch');
        } catch { throw new AppError(409, 'EVIDENCE_UNAVAILABLE', 'Evidence could not be verified before purchase'); }
      }
      if (!payment) {
        if (payload) throw new AppError(409, 'QUOTE_REQUIRED', 'Request a quote before authorizing payment');
        const config = this.service.config, recipient = config.X402_PAY_TO_ACCOUNT_ID;
        if (!recipient) throw new AppError(503, 'PAYMENT_NOT_CONFIGURED', 'Verifier recipient account is not configured');
        const amount = tinybars(config.X402_VERIFIER_PRICE_HBAR);
        if (amount > tinybars(task.spec.verificationPriceLimit.amount)) throw new AppError(409, 'VERIFICATION_BUDGET_EXCEEDED', 'Verification price exceeds task budget');
        const { feePayer } = await this.facilitator.supported(config.BLOCKY402_BASE_URL);
        if (feePayer === recipient) throw new AppError(503, 'PAYMENT_NOT_CONFIGURED', 'Verifier recipient must differ from the facilitator');
        if (!await this.service.ledger.accountExists(recipient)) throw new AppError(503, 'PAYMENT_NOT_CONFIGURED', 'Verifier recipient account is unavailable');
        const id = randomUUID();
        const requirements = requirementsSchema.parse({ scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: amount.toString(), payTo: recipient, maxTimeoutSeconds: 120, extra: { feePayer, memo: `fieldproof:x402:${id}` } });
        const resource = { url: `${config.API_BASE_URL.replace(/\/$/, '')}/v1/x402/verify?purchaseId=${id}`, description: 'Bicycle verification (mock analysis; real testnet payment)', mimeType: 'application/json' };
        const verification = (await tx.query('SELECT operation_id FROM verifications WHERE task_id=$1', [taskId])).rows[0];
        payment = (await tx.query('INSERT INTO verification_payments(id,task_id,verification_id,principal_id,evidence_hash,requirements,resource,facilitator_url,amount_tinybars,recipient,quoted_until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+interval \'5 minutes\') RETURNING *', [id, taskId, verification.operation_id, principal.id, evidence.aggregate_hash, JSON.stringify(requirements), JSON.stringify(resource), config.BLOCKY402_BASE_URL, amount.toString(), recipient])).rows[0];
        await taskEvent(tx, taskId, 'VERIFICATION_PAYMENT_QUOTED', { paymentId: id, amountTinybars: amount.toString() });
      }
      if (!existingKey) await tx.query('INSERT INTO verification_payment_keys(principal_id,key,request_hash,payment_id) VALUES ($1,$2,$3,$4)', [principal.id, key, fingerprint, payment.id]);
      if (payment.evidence_hash !== evidence.aggregate_hash || BigInt(payment.amount_tinybars) > tinybars(task.spec.verificationPriceLimit.amount)) throw new AppError(409, 'PURCHASE_MISMATCH', 'Purchase no longer matches evidence or budget');
      if (!payload) {
        if (payment.quoted_until <= new Date()) payment = (await tx.query("UPDATE verification_payments SET quoted_until=now()+interval '5 minutes' WHERE id=$1 RETURNING *", [payment.id])).rows[0];
        return this.challenge(payment);
      }
      if (payment.quoted_until <= new Date()) return this.challenge(payment, 'QUOTE_EXPIRED');
      let inspected;
      try { inspected = inspectAuthorization(payload, payment.requirements, payment.resource); }
      catch (e) { if (e instanceof AppError) return this.challenge(payment, e.code); throw e; }
      // Serialize ID registration across different tasks, even if a different envelope wraps the same transfer.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`x402-tx:${inspected.transactionId}`]);
      if ((await tx.query('SELECT 1 FROM verification_payments WHERE transaction_id=$1', [inspected.transactionId])).rowCount) throw new AppError(409, 'PAYMENT_REPLAY', 'Transaction already belongs to another purchase');
      const verified = await this.facilitator.verify(payment.facilitator_url, payload, payment.requirements);
      if (!verified.isValid || verified.payer !== inspected.payer) return this.challenge(payment, 'PAYMENT_SIGNATURE_INVALID');
      payment = (await tx.query("UPDATE verification_payments SET status='AUTHORIZED',payment_payload=$2,authorization_hash=$3,transaction_id=$4,payer=$5 WHERE id=$1 RETURNING *", [payment.id, JSON.stringify(payload), hashJson(payload), inspected.transactionId, inspected.payer])).rows[0];
      await enqueue(tx, 'x402_settle', taskId, `x402-settle:${payment.id}`);
      await taskEvent(tx, taskId, 'VERIFICATION_PAYMENT_AUTHORIZED', { paymentId: payment.id, transactionId: payment.transaction_id });
      return { status: 202, body: this.view(payment), headers: { 'Cache-Control': 'no-store' } };
    });
  }

  async status(principal: Principal, id: string): Promise<PaymentReply> {
    const row = (await this.service.db.query('SELECT * FROM verification_payments WHERE id=$1', [id]))[0];
    if (!row) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Purchase not found');
    await this.service.authorizeRead(principal, row.task_id);
    return { status: 200, body: this.view(row), headers: row.status === 'CONFIRMED' ? { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(row.settlement) } : {} };
  }

  async settle(taskId: string): Promise<void> {
    const db = this.service.db;
    const row = (await db.query('SELECT * FROM verification_payments WHERE task_id=$1', [taskId]))[0];
    if (!row?.payment_payload) throw new Error('PAYMENT_AUTHORIZATION_MISSING');
    if (row.status === 'CONFIRMED') return;
    if (row.status === 'FAILED') throw new Error('PAYMENT_FAILED');
    const task = (await db.query('SELECT status,verification_payment_mode FROM tasks WHERE id=$1', [taskId]))[0];
    if (task.status !== 'EVIDENCE_SUBMITTED' || task.verification_payment_mode !== 'x402') throw new Error('PAYMENT_TASK_STATE_MISMATCH');
    let settlement: SettleResponse | undefined;
    if (row.status !== 'AUTHORIZED') {
      const existing = await this.service.ledger.mirrorTransaction(row.transaction_id);
      if (existing) {
        if (!matchesPaymentTransfer(existing, row)) {
          await db.query("UPDATE verification_payments SET status='FAILED',last_error='PAYMENT_LEDGER_MISMATCH' WHERE id=$1", [row.id]);
          throw new Error('PAYMENT_LEDGER_MISMATCH');
        }
        settlement = { success: true, transaction: row.transaction_id, network: 'hedera:testnet', payer: row.payer };
      }
    }
    if (!settlement) {
      await db.query("UPDATE verification_payments SET status='SETTLING',last_error=NULL WHERE id=$1", [row.id]);
      try {
        settlement = await this.facilitator.settle(row.facilitator_url, row.payment_payload, row.requirements);
        if (!settlement.success || settlement.transaction !== row.transaction_id || settlement.payer !== row.payer || settlement.network !== 'hedera:testnet') throw new Error('Uncertain settlement');
      } catch {
        await db.query("UPDATE verification_payments SET status='UNKNOWN',last_error='PAYMENT_SETTLEMENT_UNCERTAIN' WHERE id=$1", [row.id]);
        throw new Error('PAYMENT_SETTLEMENT_UNCERTAIN');
      }
    }
    await db.transaction(async tx => {
      const locked = await this.service.lockedTask(tx, taskId);
      await tx.query("UPDATE verification_payments SET status='CONFIRMED',settlement=$2,confirmed_at=now(),last_error=NULL WHERE id=$1", [row.id, JSON.stringify(settlement)]);
      await taskEvent(tx, taskId, 'VERIFICATION_PAYMENT_CONFIRMED', { paymentId: row.id, transactionId: row.transaction_id });
      await transition(tx, locked, 'VERIFYING');
      await enqueue(tx, 'verify', taskId, `verify:${taskId}`);
    });
  }
}
