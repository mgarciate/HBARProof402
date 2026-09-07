import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { PrivateKey } from '@hiero-ledger/sdk';
import { z } from 'zod';
import { accountId, tinybars } from '../src/domain.js';

const settingsSchema = z.object({
  HEDERA_NETWORK: z.literal('testnet'),
  HEDERA_OPERATOR_ID: accountId,
  HEDERA_OPERATOR_KEY: z.string().min(1),
  HEDERA_HCS_TOPIC_ID: accountId,
  HEDERA_MIRROR_NODE_URL: z.string().url().default('https://testnet.mirrornode.hedera.com'),
  HEDERA_FEE_RESERVE_HBAR: z.string().default('2'),
  VERIFICATION_PAYMENT_MODE: z.literal('x402'),
  BLOCKY402_BASE_URL: z.string().url(),
  X402_VERIFIER_PRICE_HBAR: z.string().min(1),
  X402_PAY_TO_ACCOUNT_ID: accountId,
  AGENT_HEDERA_ACCOUNT_ID: accountId,
  AGENT_HEDERA_PRIVATE_KEY: z.string().min(1),
  DEMO_PAYOUT_ACCOUNT_ID: accountId,
  AGENT_API_TOKEN: z.string().min(32),
  WORKER_API_TOKEN: z.string().min(32),
  API_BASE_URL: z.string().url(),
});

type Fetch = typeof fetch;
type MirrorAccount = { account?: string; balance?: { balance?: number | string }; key?: { key?: string } | string };
export type PreflightReport = {
  network: 'hedera:testnet'; facilitatorFeePayer: string; priceTinybars: string;
  accounts: Array<{ role: string; id: string; balanceTinybars: string; keyMatched?: boolean }>;
  topicId: string; apiReady: true; seededRoles: ['agent', 'worker'];
};

async function json(fetcher: Fetch, url: string, init?: RequestInit): Promise<any> {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`PREFLIGHT_HTTP_${response.status}:${new URL(url).pathname}`);
  return response.json();
}

function mirrorKey(value: MirrorAccount['key']): string | undefined {
  const key = typeof value === 'string' ? value : value?.key;
  return key?.replace(/^0x/i, '').toLowerCase();
}

export async function preflight(environment: NodeJS.ProcessEnv = process.env, fetcher: Fetch = fetch): Promise<PreflightReport> {
  const config = settingsSchema.parse(environment);
  const price = tinybars(config.X402_VERIFIER_PRICE_HBAR);
  const reserve = tinybars(config.HEDERA_FEE_RESERVE_HBAR);
  if (price > tinybars('0.01')) throw new Error('PREFLIGHT_PRICE_EXCEEDS_DEMO_BUDGET');
  if (new Set([config.HEDERA_OPERATOR_ID, config.AGENT_HEDERA_ACCOUNT_ID, config.X402_PAY_TO_ACCOUNT_ID, config.DEMO_PAYOUT_ACCOUNT_ID]).size !== 4) {
    throw new Error('PREFLIGHT_ACCOUNTS_MUST_BE_DISTINCT');
  }
  const operatorKey = PrivateKey.fromString(config.HEDERA_OPERATOR_KEY);
  const agentKey = PrivateKey.fromStringDer(config.AGENT_HEDERA_PRIVATE_KEY);
  const facilitator = await json(fetcher, `${config.BLOCKY402_BASE_URL.replace(/\/$/, '')}/supported`);
  const kind = z.object({ kinds: z.array(z.object({ x402Version: z.number(), scheme: z.string(), network: z.string(), extra: z.object({ feePayer: z.string().optional() }).passthrough().optional() })) })
    .parse(facilitator).kinds.find(entry => entry.x402Version === 2 && entry.scheme === 'exact' && entry.network === 'hedera:testnet');
  const feePayer = accountId.safeParse(kind?.extra?.feePayer);
  if (!feePayer.success) throw new Error('PREFLIGHT_BLOCKY_HEDERA_UNAVAILABLE');
  if ([config.AGENT_HEDERA_ACCOUNT_ID, config.X402_PAY_TO_ACCOUNT_ID].includes(feePayer.data)) throw new Error('PREFLIGHT_ACCOUNT_CONFLICTS_WITH_FACILITATOR');

  const mirror = config.HEDERA_MIRROR_NODE_URL.replace(/\/$/, '');
  const definitions = [
    { role: 'operator', id: config.HEDERA_OPERATOR_ID, key: operatorKey.publicKey.toStringRaw(), minimum: reserve + tinybars('0.1') },
    { role: 'agent', id: config.AGENT_HEDERA_ACCOUNT_ID, key: agentKey.publicKey.toStringRaw(), minimum: price },
    { role: 'verifier', id: config.X402_PAY_TO_ACCOUNT_ID, minimum: 0n },
    { role: 'collaborator', id: config.DEMO_PAYOUT_ACCOUNT_ID, minimum: 0n },
  ];
  const accounts = await Promise.all(definitions.map(async definition => {
    const account = z.object({ account: accountId, balance: z.object({ balance: z.union([z.number(), z.string()]) }), key: z.union([z.string(), z.object({ key: z.string() })]).optional() })
      .parse(await json(fetcher, `${mirror}/api/v1/accounts/${definition.id}`)) as MirrorAccount;
    const balance = BigInt(account.balance!.balance!);
    if (account.account !== definition.id) throw new Error(`PREFLIGHT_ACCOUNT_MISMATCH:${definition.role}`);
    if (balance < definition.minimum) throw new Error(`PREFLIGHT_INSUFFICIENT_BALANCE:${definition.role}`);
    const actualKey = mirrorKey(account.key);
    const expectedKey = definition.key?.replace(/^0x/i, '').toLowerCase();
    if (expectedKey && actualKey !== expectedKey) throw new Error(`PREFLIGHT_PRIVATE_KEY_MISMATCH:${definition.role}`);
    return { role: definition.role, id: definition.id, balanceTinybars: balance.toString(), ...(expectedKey ? { keyMatched: true } : {}) };
  }));
  await json(fetcher, `${mirror}/api/v1/topics/${config.HEDERA_HCS_TOPIC_ID}`);

  const api = config.API_BASE_URL.replace(/\/$/, '');
  const ready = await json(fetcher, `${api}/health/ready`);
  if (ready.status !== 'ready') throw new Error('PREFLIGHT_API_NOT_READY');
  const role = async (token: string) => (await json(fetcher, `${api}/v1/me`, { headers: { Authorization: `Bearer ${token}` } })).role;
  if (await role(config.AGENT_API_TOKEN) !== 'agent' || await role(config.WORKER_API_TOKEN) !== 'worker') throw new Error('PREFLIGHT_SEEDED_ROLE_MISMATCH');
  return { network: 'hedera:testnet', facilitatorFeePayer: feePayer.data, priceTinybars: price.toString(), accounts, topicId: config.HEDERA_HCS_TOPIC_ID, apiReady: true, seededRoles: ['agent', 'worker'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    loadEnv({ path: '.env.agent', override: true });
    console.log(JSON.stringify(await preflight(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'PREFLIGHT_FAILED');
    process.exitCode = 1;
  }
}
