import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { z } from 'zod';

// canonicalize publishes a CommonJS callable with an ESM-shaped declaration.
const canonicalize: (value: unknown) => string | undefined = createRequire(import.meta.url)('canonicalize');

export class AppError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
export const accountId = z.string().regex(/^0\.0\.[1-9]\d*$/);
export const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const amount = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,8})?$/).refine(v => tinybars(v) > 0n && tinybars(v) <= 9223372036854775807n, 'Invalid positive HBAR amount');
export function tinybars(value: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(value)) throw new AppError(400, 'INVALID_AMOUNT', 'Use a non-negative HBAR decimal with at most 8 decimals');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}
export function hbar(value: bigint | string): string {
  const units = BigInt(value); const fraction = (units % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${units / 100_000_000n}${fraction ? `.${fraction}` : ''}`;
}
export function sha256(value: string | Buffer): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
export function hashJson(value: unknown): string {
  const serialized = canonicalize(value);
  if (serialized === undefined) throw new Error('Cannot hash undefined JSON');
  return sha256(serialized);
}
export const evidenceType = z.enum(['asset_overview', 'component_detail']);
export const taskInput = z.object({
  assetExternalId: z.string().min(1).max(200), expectedQrHash: hash,
  title: z.string().min(1).max(200), instructions: z.array(z.string().min(1).max(1000)).min(1).max(10),
  requiredEvidence: z.tuple([z.literal('asset_overview'), z.literal('component_detail')]),
  reward: z.object({ asset: z.literal('HBAR'), amount }).strict(),
  verificationPriceLimit: z.object({ asset: z.literal('HBAR'), amount }).strict(),
  expiresAt: z.string().datetime({ offset: true }), policyVersion: z.literal('bike-visual-v1'),
}).strict();
export const uploadsInput = z.object({ files: z.array(z.object({ type: evidenceType, sha256: hash, contentType: z.literal('image/jpeg'), size: z.number().int().min(1).max(10 * 1024 * 1024) }).strict()).length(2) }).strict();
export const evidenceInput = z.object({ qrHash: hash, files: z.array(z.object({ type: evidenceType, uploadId: z.string().uuid(), sha256: hash }).strict()).length(2), answers: z.object({ visibleDamage: z.boolean() }).strict(), consent: z.literal(true) }).strict();
export type TaskSpec = z.infer<typeof taskInput>;
export type Status = 'DRAFT' | 'OPEN' | 'CLAIMED' | 'EVIDENCE_SUBMITTED' | 'VERIFYING' | 'APPROVED' | 'REJECTED' | 'MANUAL_REVIEW' | 'PAID' | 'CANCELLED' | 'EXPIRED';
const transitions: Record<Status, Status[]> = {
  DRAFT: ['OPEN'], OPEN: ['CLAIMED', 'CANCELLED', 'EXPIRED'], CLAIMED: ['EVIDENCE_SUBMITTED', 'EXPIRED'],
  EVIDENCE_SUBMITTED: ['VERIFYING'], VERIFYING: ['APPROVED', 'REJECTED', 'MANUAL_REVIEW'], APPROVED: ['PAID'],
  PAID: [], REJECTED: [], MANUAL_REVIEW: [], CANCELLED: [], EXPIRED: [],
};
export function assertTransition(from: Status, to: Status): void {
  if (!transitions[from].includes(to)) throw new AppError(409, 'INVALID_STATE', `Cannot transition ${from} to ${to}`);
}
export function assertNotExpired(expiresAt: Date | string, now = new Date()): void {
  if (new Date(expiresAt) <= now) throw new AppError(409, 'TASK_EXPIRED', 'Task no longer accepts claims or evidence');
}
export const checksSchema = z.object({ qrMatches: z.boolean(), requiredFilesPresent: z.boolean(), exactDuplicateDetected: z.boolean(), imageReadable: z.boolean(), answerConsistent: z.boolean() }).strict();
export type Checks = z.infer<typeof checksSchema>;
export function decision(checks: Checks): 'APPROVED' | 'REJECTED' | 'MANUAL_REVIEW' {
  if (!checks.qrMatches || !checks.requiredFilesPresent || checks.exactDuplicateDetected) return 'REJECTED';
  if (!checks.imageReadable || !checks.answerConsistent) return 'MANUAL_REVIEW';
  return 'APPROVED';
}
const eventBase = { version: z.literal(1), eventId: z.string().uuid(), taskId: z.string().uuid(), timestamp: z.string().datetime() };
const hcsV1 = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('TaskCreated'), taskSpecHash: hash, rewardAsset: z.literal('HBAR'), rewardAmount: amount, expiresAt: z.string().datetime({ offset: true }), policyVersion: z.literal('bike-visual-v1') }).strict(),
  z.object({ ...eventBase, type: z.literal('EvidenceSubmitted'), evidenceAggregateHash: hash }).strict(),
  z.object({ ...eventBase, type: z.literal('VerificationCompleted'), evidenceAggregateHash: hash, result: z.enum(['APPROVED', 'REJECTED', 'MANUAL_REVIEW']), verifierVersion: z.literal('mock-bike-visual-v1'), verificationMode: z.literal('mock') }).strict(),
  z.object({ ...eventBase, type: z.literal('RewardPaid'), asset: z.literal('HBAR'), amount, rewardTransactionReferenceHash: hash }).strict(),
]);
export const hcsEventSchema = z.union([hcsV1, z.object({
  ...eventBase, version: z.literal(2), type: z.literal('VerificationCompleted'),
  evidenceAggregateHash: hash, result: z.enum(['APPROVED', 'REJECTED', 'MANUAL_REVIEW']),
  verifierVersion: z.literal('mock-bike-visual-v1'), verificationMode: z.literal('mock'),
  x402PaymentReferenceHash: hash,
}).strict()]);
export type HcsEvent = z.infer<typeof hcsEventSchema>;
export function transactionPath(id: string): string { return id.replace('@', '-').replace(/\.(\d+)$/, '-$1'); }
export function transactionUrl(id: string): string { return `https://hashscan.io/testnet/transaction/${encodeURIComponent(transactionPath(id))}`; }
