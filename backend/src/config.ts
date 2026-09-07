import 'dotenv/config';
import { z } from 'zod';
import { accountId, amount } from './domain.js';

const environment = z.object({
  PORT: z.coerce.number().int().positive().default(3000), HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  OBJECT_STORAGE_ENDPOINT: z.string().url(), OBJECT_STORAGE_PUBLIC_ENDPOINT: z.string().url().optional(),
  OBJECT_STORAGE_REGION: z.string().default('us-east-1'), OBJECT_STORAGE_BUCKET: z.string().min(1),
  OBJECT_STORAGE_ACCESS_KEY: z.string().min(1), OBJECT_STORAGE_SECRET_KEY: z.string().min(1),
  HEDERA_NETWORK: z.literal('testnet').default('testnet'),
  HEDERA_OPERATOR_ID: z.string().regex(/^0\.0\.[1-9]\d*$/), HEDERA_OPERATOR_KEY: z.string().min(1),
  HEDERA_HCS_TOPIC_ID: z.string().regex(/^0\.0\.[1-9]\d*$/),
  HEDERA_MIRROR_NODE_URL: z.string().url().default('https://testnet.mirrornode.hedera.com'),
  HEDERA_FEE_RESERVE_HBAR: z.string().default('2'),
  VERIFIER_MODE: z.literal('mock').default('mock'),
  MOCK_VERIFIER_SCENARIO: z.enum(['approve', 'reject', 'manual_review', 'transient_error']).default('approve'),
  VERIFICATION_PAYMENT_MODE: z.enum(['free_mock', 'x402']).default('free_mock'),
  BLOCKY402_BASE_URL: z.string().url().default('https://api.testnet.blocky402.com'),
  X402_VERIFIER_PRICE_HBAR: amount.default('0.001'),
  X402_PAY_TO_ACCOUNT_ID: z.preprocess(v => v === '' ? undefined : v, accountId.optional()),
  API_BASE_URL: z.string().url().default('http://localhost:3000'),
});
export type Config = z.infer<typeof environment>;
export function readConfig(): Config {
  const config = environment.parse(process.env);
  if (config.VERIFICATION_PAYMENT_MODE === 'x402' && !config.X402_PAY_TO_ACCOUNT_ID) throw new Error('X402_PAY_TO_ACCOUNT_ID is required in x402 mode');
  return config;
}
