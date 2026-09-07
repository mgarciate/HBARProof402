import { checksSchema, decision, type Checks } from './domain.js';
import { z } from 'zod';

export const resultSchema = z.object({
  taskId: z.string().uuid(), status: z.enum(['APPROVED', 'REJECTED', 'MANUAL_REVIEW']), checks: checksSchema,
  verifierVersion: z.literal('mock-bike-visual-v1'), verificationMode: z.literal('mock'),
  x402PaymentReference: z.string().regex(/^0\.0\.\d+@\d+\.\d{1,9}$/).nullable(), evidenceAggregateHash: z.string(),
}).strict();
export type VerificationResult = z.infer<typeof resultSchema>;
export type VerificationRequest = { operationId: string; taskId: string; scenario: string; attempt: number; checks: Checks; evidenceAggregateHash: string };
export interface VerifierAdapter {
  request(input: VerificationRequest): Promise<VerificationResult>;
  recover(input: VerificationRequest): Promise<VerificationResult>;
}
export class MockVerifierAdapter implements VerifierAdapter {
  async request(input: VerificationRequest): Promise<VerificationResult> {
    if (input.scenario === 'transient_error' && input.attempt === 0) throw new Error('MOCK_TRANSIENT_ERROR');
    const checks = { ...input.checks };
    if (input.scenario === 'reject') checks.requiredFilesPresent = false;
    if (input.scenario === 'manual_review') checks.imageReadable = false;
    return resultSchema.parse({ taskId: input.taskId, status: decision(checks), checks, verifierVersion: 'mock-bike-visual-v1', verificationMode: 'mock', x402PaymentReference: null, evidenceAggregateHash: input.evidenceAggregateHash });
  }
  async recover(input: VerificationRequest): Promise<VerificationResult> { return this.request(input); }
}
