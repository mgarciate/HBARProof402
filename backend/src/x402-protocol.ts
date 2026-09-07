import { z } from 'zod';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { inspectHederaTransaction, Transaction, TransferTransaction } from '@x402/hedera';
import { accountId, AppError, hashJson } from './domain.js';

export const requirementsSchema = z.object({
  scheme: z.literal('exact'), network: z.literal('hedera:testnet'), asset: z.literal('0.0.0'),
  amount: z.string().regex(/^[1-9]\d*$/).refine(v => BigInt(v) <= 9223372036854775807n),
  payTo: accountId, maxTimeoutSeconds: z.number().int().min(1).max(120),
  extra: z.object({ feePayer: accountId, memo: z.string().regex(/^fieldproof:x402:[0-9a-f-]{36}$/) }).strict(),
}).strict();
export const resourceSchema = z.object({ url: z.string().url(), description: z.string().optional(), mimeType: z.string().optional() }).strict();
export const paymentPayloadSchema = z.object({
  x402Version: z.literal(2), resource: resourceSchema,
  accepted: requirementsSchema,
  payload: z.object({ transaction: z.string().min(1).max(20_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict(),
}).strict();
export function decodeAuthorization(header: string): PaymentPayload {
  try {
    if (header.length > 24_000) throw new Error('Too large');
    return paymentPayloadSchema.parse(decodePaymentSignatureHeader(header));
  } catch { throw new AppError(400, 'INVALID_PAYMENT_PAYLOAD', 'Invalid x402 v2 payment signature'); }
}

export function inspectAuthorization(payload: PaymentPayload, requirements: PaymentRequirements, resource: unknown): { transactionId: string; payer: string } {
  const parsed = paymentPayloadSchema.parse(payload);
  if (hashJson(parsed.accepted) !== hashJson(requirements) || hashJson(parsed.resource) !== hashJson(resource)) throw new AppError(402, 'PAYMENT_REQUIREMENTS_MISMATCH', 'Payment must match the issued quote and resource');
  try {
    const tx = Transaction.fromBytes(Buffer.from(parsed.payload.transaction, 'base64'));
    const inspected = inspectHederaTransaction(parsed.payload.transaction);
    const debits = inspected.hbarTransfers.filter(t => BigInt(t.amount) < 0n);
    const credits = inspected.hbarTransfers.filter(t => BigInt(t.amount) > 0n);
    if (!(tx instanceof TransferTransaction) || inspected.hasNonTransferOperations || Object.keys(inspected.tokenTransfers).length ||
        inspected.transactionIdAccountId !== requirements.extra.feePayer || tx.transactionMemo !== requirements.extra.memo ||
        debits.length !== 1 || credits.length !== 1 || credits[0]!.accountId !== requirements.payTo ||
        credits[0]!.amount !== requirements.amount || BigInt(debits[0]!.amount) !== -BigInt(requirements.amount) ||
        debits[0]!.accountId === requirements.extra.feePayer || requirements.payTo === requirements.extra.feePayer ||
        !accountId.safeParse(debits[0]!.accountId).success) throw new Error('Transfer mismatch');
    return { transactionId: inspected.transactionId, payer: debits[0]!.accountId };
  } catch { throw new AppError(402, 'PAYMENT_TRANSFER_MISMATCH', 'Signed HBAR transfer does not match this purchase'); }
}

export interface Facilitator {
  supported(baseUrl: string): Promise<{ feePayer: string }>;
  verify(baseUrl: string, payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ isValid: boolean; payer?: string }>;
  settle(baseUrl: string, payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

/** Uses the canonical Blocky402 v2 body; no legacy HTTP headers or client-side settlement. */
export class Blocky402Facilitator implements Facilitator {
  private async request(base: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    if (!response.ok) throw new AppError(503, 'FACILITATOR_UNAVAILABLE', 'Blocky402 request failed; retry the same operation');
    return response.json();
  }
  async supported(base: string): Promise<{ feePayer: string }> {
    const response = z.object({ kinds: z.array(z.object({ x402Version: z.number(), scheme: z.string(), network: z.string(), extra: z.object({ feePayer: z.string().optional() }).passthrough().optional() })) }).parse(await this.request(base, '/supported'));
    const kind = response.kinds.find(k => k.x402Version === 2 && k.scheme === 'exact' && k.network === 'hedera:testnet');
    const parsed = accountId.safeParse(kind?.extra?.feePayer);
    if (!parsed.success) throw new AppError(503, 'HEDERA_X402_UNAVAILABLE', 'Facilitator does not advertise Hedera testnet exact v2 with a fee payer');
    return { feePayer: parsed.data };
  }
  async verify(base: string, paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<{ isValid: boolean; payer?: string }> {
    return z.object({ isValid: z.boolean(), payer: accountId.optional() }).parse(await this.request(base, '/verify', { x402Version: 2, paymentPayload, paymentRequirements }));
  }
  async settle(base: string, paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return z.object({ success: z.boolean(), transaction: z.string(), network: z.literal('hedera:testnet'), payer: accountId.optional(), errorReason: z.string().optional() }).parse(await this.request(base, '/settle', { x402Version: 2, paymentPayload, paymentRequirements }));
  }
}

export function matchesPaymentTransfer(tx: any, payment: { recipient: string; amount_tinybars: string; payer: string; requirements: PaymentRequirements }): boolean {
  if (tx.result !== 'SUCCESS' || tx.name !== 'CRYPTOTRANSFER') return false;
  const transfers = tx.transfers ?? [];
  const net = (account: string) => transfers.filter((t: any) => t.account === account).reduce((sum: bigint, t: any) => sum + BigInt(t.amount), 0n);
  return net(payment.recipient) === BigInt(payment.amount_tinybars) && net(payment.payer) === -BigInt(payment.amount_tinybars) &&
    Buffer.from(tx.memo_base64 ?? '', 'base64').toString('utf8') === payment.requirements.extra.memo;
}
