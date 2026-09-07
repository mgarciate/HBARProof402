import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { assertNotExpired, assertTransition, decision, hashJson, hcsEventSchema, hbar, sha256, tinybars, transactionPath } from '../src/domain.js';
import { validateImage } from '../src/storage.js';
import { MockVerifierAdapter } from '../src/verifier.js';

describe('domain invariants', () => {
  it('uses exact tinybars without floating point', () => {
    expect(tinybars('0.00000001')).toBe(1n); expect(hbar(500_000_001n)).toBe('5.00000001');
    expect(() => tinybars('0.000000001')).toThrow(); expect(() => tinybars('-1')).toThrow();
  });
  it('requires approval before PAID and forbids reopening terminal states', () => {
    expect(() => assertTransition('VERIFYING', 'PAID')).toThrow();
    expect(() => assertTransition('PAID', 'OPEN')).toThrow();
    expect(() => assertTransition('APPROVED', 'PAID')).not.toThrow();
  });
  it('closes the exact expiry boundary', () => {
    const date = new Date('2026-09-07T10:00:00Z'); expect(() => assertNotExpired(date, date)).toThrow();
  });
  it('hashes reordered keys identically and commits answers', () => {
    expect(hashJson({ b: 2, a: 1 })).toBe(hashJson({ a: 1, b: 2 }));
    expect(hashJson({ answers: { visibleDamage: false } })).not.toBe(hashJson({ answers: { visibleDamage: true } }));
  });
  it('normalizes transaction IDs without losing account dots or nanoseconds', () => {
    expect(transactionPath('0.0.123@1788775200.000000001')).toBe('0.0.123-1788775200-000000001');
  });
  it('rejects private fields in HCS and marks mock results explicitly', () => {
    const base = { version: 1, eventId: randomUUID(), taskId: randomUUID(), timestamp: new Date().toISOString(), type: 'VerificationCompleted', evidenceAggregateHash: sha256('e'), result: 'APPROVED', verifierVersion: 'mock-bike-visual-v1', verificationMode: 'mock' };
    expect(hcsEventSchema.safeParse(base).success).toBe(true);
    expect(hcsEventSchema.safeParse({ ...base, payoutAccountId: '0.0.123' }).success).toBe(false);
    expect(hcsEventSchema.safeParse({ ...base, signedUrl: 'https://private' }).success).toBe(false);
  });
  it('applies rejection before manual review and never relies on confidence', () => {
    const checks = { qrMatches: true, requiredFilesPresent: true, exactDuplicateDetected: false, imageReadable: true, answerConsistent: true };
    expect(decision(checks)).toBe('APPROVED');
    expect(decision({ ...checks, answerConsistent: false })).toBe('MANUAL_REVIEW');
    expect(decision({ ...checks, qrMatches: false, imageReadable: false })).toBe('REJECTED');
  });
  it('distinguishes transient mock failures from business rejection', async () => {
    const adapter = new MockVerifierAdapter();
    const request = { operationId: randomUUID(), taskId: randomUUID(), scenario: 'transient_error', attempt: 0, evidenceAggregateHash: sha256('e'), checks: { qrMatches: true, requiredFilesPresent: true, exactDuplicateDetected: false, imageReadable: true, answerConsistent: true } };
    await expect(adapter.request(request)).rejects.toThrow('MOCK_TRANSIENT_ERROR');
    expect(await adapter.recover({ ...request, attempt: 1 })).toMatchObject({ status: 'APPROVED', verificationMode: 'mock', x402PaymentReference: null });
  });
});
describe('image integrity', () => {
  it('accepts sanitized JPEG and rejects wrong hashes and declared sizes', async () => {
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).jpeg().toBuffer();
    await expect(validateImage(bytes, sha256(bytes), bytes.length)).resolves.toBeUndefined();
    await expect(validateImage(bytes, sha256('wrong'), bytes.length)).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    await expect(validateImage(bytes, sha256(bytes), bytes.length + 1)).rejects.toMatchObject({ code: 'INVALID_FILE_SIZE' });
  });
  it('rejects metadata, other formats and truncated content', async () => {
    const image = sharp({ create: { width: 32, height: 32, channels: 3, background: 'blue' } });
    for (const bytes of [await image.clone().withMetadata().jpeg().toBuffer(), await image.clone().png().toBuffer(), Buffer.from('not an image')]) {
      await expect(validateImage(bytes, sha256(bytes), bytes.length)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    }
  });
});
