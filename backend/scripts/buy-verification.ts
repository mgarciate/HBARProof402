import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { PrivateKey } from '@x402/hedera';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';
import { purchaseSigner, selectRequirements, signPurchase } from '../src/x402-client.js';
import { inspectAuthorization, paymentPayloadSchema } from '../src/x402-protocol.js';

type Journal = { taskId: string; apiBase: string; key: string; paymentId: string; payload: PaymentPayload };
export async function buyVerification(taskId: string): Promise<any> {
  // Agent-only values intentionally override blank placeholders loaded from .env.
  loadEnv({ path: '.env.agent', override: true });
  z.string().uuid().parse(taskId);
  const apiBase = z.string().url().parse(process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const token = z.string().min(32).parse(process.env.AGENT_API_TOKEN);
  const recipient = z.string().min(1).parse(process.env.X402_PAY_TO_ACCOUNT_ID);
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${apiBase}${path}`, { ...init, redirect: 'error', headers: { ...init.headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    const body = await response.json();
    if (![200, 202, 402].includes(response.status)) throw new Error(`API ${response.status}: ${body.error?.code ?? 'REQUEST_FAILED'}`);
    return { response, body };
  };
  const awaitResult = async (paymentId: string) => {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const { body: payment } = await call(`/v1/x402/payments/${paymentId}`);
      if (payment.status === 'FAILED') throw new Error('Payment conclusively failed. Operator review required before another authorization.');
      if (payment.status === 'CONFIRMED') {
        const result = await call(`/v1/tasks/${taskId}/result`);
        if (result.response.status === 200) { console.log(`x402 confirmed: ${payment.transactionId}`); return result.body; }
      }
      await setTimeout(3000);
    }
    throw new Error(`Purchase ${paymentId} still pending. Recover the same operation; do not sign another payment.`);
  };
  const { body: task } = await call(`/v1/tasks/${taskId}`);
  if (task.verificationPaymentMode !== 'x402') throw new Error('Task does not use x402');
  if (task.verificationPayment && task.verificationPayment.status !== 'QUOTED') return awaitResult(task.verificationPayment.id);
  const directory = resolve(process.env.X402_JOURNAL_DIR ?? '.x402-payments');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `${taskId}.json`);
  let journal: Journal;
  try {
    journal = JSON.parse(await readFile(path, 'utf8'));
    z.string().uuid().parse(journal.paymentId); z.string().min(8).max(200).parse(journal.key);
    if (journal.taskId !== taskId || journal.apiBase !== apiBase) throw new Error('Journal belongs to a different resource');
    paymentPayloadSchema.parse(journal.payload);
    if (journal.payload.accepted.extra.memo !== `fieldproof:x402:${journal.paymentId}`) throw new Error('Journal purchase mismatch');
    selectRequirements({ x402Version: 2, resource: journal.payload.resource!, accepts: [journal.payload.accepted] }, task.verificationPriceLimit.amount, recipient, apiBase);
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw new Error('Saved authorization is incomplete or invalid; inspect it before any new payment');
    if (task.verificationPayment && task.verificationPayment.status !== 'QUOTED') throw new Error(`Purchase ${task.verificationPayment.id} already authorized. Recover it through the API; do not sign another payment.`);
    const key = randomUUID();
    const quote = await call('/v1/x402/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ taskId }) });
    if (quote.response.status !== 402) return quote.body;
    const challenge = decodePaymentRequiredHeader(z.string().parse(quote.response.headers.get('payment-required')));
    const requirements = selectRequirements(challenge, task.verificationPriceLimit.amount, recipient, apiBase);
    console.log(`Agent accepted ${requirements.amount} tinybars within the task budget; analysis remains mock.`);
    // Exclusive creation precedes signing. A crash leaves a file that fails closed, never two signers.
    const payer = z.string().min(1).parse(process.env.AGENT_HEDERA_ACCOUNT_ID);
    const privateKey = PrivateKey.fromStringDer(z.string().min(1).parse(process.env.AGENT_HEDERA_PRIVATE_KEY));
    const handle = await open(path, 'wx', 0o600);
    try {
      const payload = await signPurchase(challenge, requirements, purchaseSigner(payer, privateKey));
      inspectAuthorization(payload, requirements, challenge.resource);
      journal = { taskId, apiBase, key, paymentId: quote.body.purchase.id, payload };
      await handle.writeFile(JSON.stringify(journal)); await handle.sync();
    } finally { await handle.close(); }
  }
  const authorization = await call('/v1/x402/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': journal.key, 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(journal.payload) }, body: JSON.stringify({ taskId }),
  });
  if (authorization.response.status === 402) throw new Error(`Payment not accepted: ${authorization.body.error ?? 'PAYMENT_REJECTED'}. Saved authorization retained; no second payment was signed.`);
  return awaitResult(journal.paymentId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await buyVerification(process.argv[2]!), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Purchase failed'); process.exitCode = 1; }
}
