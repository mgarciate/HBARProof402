import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buyVerification } from '../scripts/buy-verification.js';
import { S3Client, CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { Database } from '../src/db.js';
import { Marketplace } from '../src/service.js';
import { Processor } from '../src/processor.js';
import { buildApp } from '../src/app.js';
import { MockVerifierAdapter } from '../src/verifier.js';
import { S3Storage } from '../src/storage.js';
import { hashJson, sha256 } from '../src/domain.js';
import type { Config } from '../src/config.js';
import { FakeLedger, FakeFacilitator } from './fakes.js';
import { Payments } from '../src/payments.js';
import { purchaseSigner, signPurchase } from '../src/x402-client.js';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';
import { PrivateKey } from '@x402/hedera';

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('Marketplace with real PostgreSQL and S3, test-only ledger', () => {
const config: Config = { VERIFICATION_PAYMENT_MODE: 'free_mock', BLOCKY402_BASE_URL: 'https://facilitator.test', X402_VERIFIER_PRICE_HBAR: '0.001', API_BASE_URL: 'http://localhost:3000', X402_PAY_TO_ACCOUNT_ID: '0.0.400', PORT: 3000, HOST: '127.0.0.1', DATABASE_URL: 'postgres://fieldproof:test-password@127.0.0.1:55432/fieldproof_test', OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:59000', OBJECT_STORAGE_REGION: 'us-east-1', OBJECT_STORAGE_BUCKET: 'fieldproof-test', OBJECT_STORAGE_ACCESS_KEY: 'fieldproof', OBJECT_STORAGE_SECRET_KEY: 'test-storage-password', HEDERA_NETWORK: 'testnet', HEDERA_OPERATOR_ID: '0.0.100', HEDERA_OPERATOR_KEY: 'unused-in-test', HEDERA_HCS_TOPIC_ID: '0.0.200', HEDERA_MIRROR_NODE_URL: 'https://testnet.mirrornode.hedera.com', HEDERA_FEE_RESERVE_HBAR: '2', VERIFIER_MODE: 'mock', MOCK_VERIFIER_SCENARIO: 'approve' };
  const db = new Database(config.DATABASE_URL), storage = new S3Storage(config);
  const s3 = new S3Client({ endpoint: config.OBJECT_STORAGE_ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY, secretAccessKey: config.OBJECT_STORAGE_SECRET_KEY } });
  let ledger: FakeLedger, service: Marketplace, processor: Processor, app: Awaited<ReturnType<typeof buildApp>>;
  let facilitator: FakeFacilitator, payments: Payments;
  const tokens = { agent: 'test-agent-token-aaaaaaaaaaaaaaaaaaaa', worker: 'test-worker-token-aaaaaaaaaaaaaaaaaa', other: 'test-worker-token-bbbbbbbbbbbbbbbbbb', operator: 'test-operator-token-aaaaaaaaaaaaaaaa' };
  let ids: Record<string, string>;
  let imageA: Buffer, imageB: Buffer;
  beforeAll(async () => {
    if (!(await db.query("SELECT current_database() AS name"))[0].name.endsWith('_test')) throw new Error('Tests require dedicated test database');
    if (!(await db.query("SELECT to_regclass('public.tasks') AS table_name"))[0].table_name) await db.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
    if (!(await db.query("SELECT to_regclass('public.private_objects') AS table_name"))[0].table_name) await db.query(await readFile(new URL('../migrations/002_private_objects.sql', import.meta.url), 'utf8'));
    if (!(await db.query("SELECT to_regclass('public.verification_payments') AS table_name"))[0].table_name) await db.query(await readFile(new URL('../migrations/003_verification_payments.sql', import.meta.url), 'utf8'));
    try { await s3.send(new CreateBucketCommand({ Bucket: config.OBJECT_STORAGE_BUCKET })); } catch (e: any) { if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(e.name)) throw e; }
    imageA = await sharp({ create: { width: 40, height: 40, channels: 3, background: 'red' } }).jpeg().toBuffer();
    imageB = await sharp({ create: { width: 40, height: 40, channels: 3, background: 'blue' } }).jpeg().toBuffer();
  });
  beforeEach(async () => {
    if (app) await app.close();
    await db.query('TRUNCATE principals CASCADE');
    ledger = new FakeLedger(); service = new Marketplace(db, ledger, storage, { ...config }); processor = new Processor(service, new MockVerifierAdapter());
    facilitator = new FakeFacilitator(ledger); payments = new Payments(service, facilitator);
    processor = new Processor(service, new MockVerifierAdapter(), payments);
    ids = {};
    for (const [name, token] of Object.entries(tokens)) {
      const id = randomUUID(); ids[name] = id; const role = name === 'other' ? 'worker' : name;
      await db.query('INSERT INTO principals(id,role,token_hash) VALUES ($1,$2,$3)', [id, role, sha256(token)]);
      if (role === 'worker') await db.query("INSERT INTO workers(id,payout_account_id,verified_at) VALUES ($1,'0.0.300',now())", [id]);
    }
    app = await buildApp(service, false, payments);
  });
  afterAll(async () => { if (app) await app.close(); await db.close(); s3.destroy(); });
  function call(method: 'GET' | 'POST' | 'PUT', url: string, role: keyof typeof tokens = 'agent', payload?: any, key = randomUUID()) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${tokens[role]}`, 'idempotency-key': key }, ...(payload === undefined ? {} : { payload }) });
  }
  function spec() { return { assetExternalId: 'bike_01', expectedQrHash: sha256('QR'), title: 'Bicycle', instructions: ['Side', 'Detail'], requiredEvidence: ['asset_overview', 'component_detail'], reward: { asset: 'HBAR', amount: '5' }, verificationPriceLimit: { asset: 'HBAR', amount: '1' }, expiresAt: new Date(Date.now() + 60_000).toISOString(), policyVersion: 'bike-visual-v1' }; }
  async function openTask() {
    const response = await call('POST', '/v1/tasks', 'agent', spec()); expect(response.statusCode, response.body).toBe(202);
    const id = response.json().id; await processor.tick(); return id as string;
  }
  async function claimedTask() { const id = await openTask(); expect((await call('POST', `/v1/tasks/${id}/claim`, 'worker', {})).statusCode).toBe(200); return id; }
  async function uploaded(id: string) {
    const files = [{ type: 'asset_overview', bytes: imageA }, { type: 'component_detail', bytes: imageB }];
    const response = await call('POST', `/v1/tasks/${id}/evidence/uploads`, 'worker', { files: files.map(f => ({ type: f.type, size: f.bytes.length, sha256: sha256(f.bytes), contentType: 'image/jpeg' })) });
    expect(response.statusCode, response.body).toBe(201);
    const uploads = response.json().files;
    for (let i = 0; i < uploads.length; i++) expect((await fetch(uploads[i].url, { method: 'PUT', headers: uploads[i].headers, body: new Uint8Array(files[i]!.bytes) })).ok).toBe(true);
    return { qrHash: sha256('QR'), consent: true, answers: { visibleDamage: true }, files: uploads.map((u: any, i: number) => ({ uploadId: u.uploadId, type: u.type, sha256: sha256(files[i]!.bytes) })) };
  }
  async function drain() { for (let i = 0; i < 15 && await processor.tick(); i++); }
  async function payableTask() {
    service.config.VERIFICATION_PAYMENT_MODE = 'x402';
    const id = await claimedTask(), body = await uploaded(id);
    expect((await call('POST', `/v1/tasks/${id}/evidence`, 'worker', body)).statusCode).toBe(202);
    await drain(); return id;
  }
  async function offer(id: string, key = randomUUID()) {
    const response = await call('POST', '/v1/x402/verify', 'agent', { taskId: id }, key);
    expect(response.statusCode, response.body).toBe(402); expect(response.headers['payment-required']).toBeTruthy();
    return { key, challenge: response.json() };
  }
  async function signed(challenge: any, wrongKey = false) {
    return signPurchase(challenge, challenge.accepts[0], purchaseSigner(facilitator.payer, wrongKey ? PrivateKey.generateED25519() : facilitator.payerKey));
  }
  function authorize(id: string, payload: PaymentPayload, key: string) {
    return app.inject({ method: 'POST', url: '/v1/x402/verify', headers: { authorization: `Bearer ${tokens.agent}`, 'idempotency-key': key, 'payment-signature': encodePaymentSignatureHeader(payload) }, payload: { taskId: id } });
  }
  it('gates x402 verification, settles once and publishes a paid mock receipt', async () => {
    const id = await payableTask();
    expect((await call('GET', `/v1/tasks/${id}`)).json()).toMatchObject({ status: 'EVIDENCE_SUBMITTED', x402PaymentStatus: 'awaiting_payment' });
    expect((await db.query("SELECT count(*) FROM jobs WHERE kind='verify'"))[0].count).toBe('0');
    const { challenge, key } = await offer(id), payload = await signed(challenge);
    const accepted = await authorize(id, payload, key); expect(accepted.statusCode, accepted.body).toBe(202);
    expect(facilitator.chargeCount).toBe(0); await drain();
    expect((await call('GET', `/v1/tasks/${id}`)).json().status).toBe('PAID');
    const receipt = (await call('GET', `/v1/tasks/${id}/receipt/verify`)).json();
    expect(receipt.status).toBe('verified_mock_flow'); expect(receipt.checks.x402).toBe('verified'); expect(receipt.x402PaymentStatus).toBe('confirmed');
    expect(receipt.result).toMatchObject({ verificationMode: 'mock', x402PaymentReference: receipt.x402Payment.transactionId });
    expect((await db.query("SELECT payload FROM hcs_events WHERE task_id=$1 AND type='VerificationCompleted'", [id]))[0].payload.version).toBe(2);
    expect((await authorize(id, payload, key)).statusCode).toBe(200);
    const status = await call('GET', `/v1/x402/payments/${accepted.json().id}`); expect(status.headers['payment-response']).toBeTruthy();
    expect((await call('POST', '/v1/x402/verify', 'agent', { taskId: id }, randomUUID())).statusCode).toBe(200);
    expect(facilitator.chargeCount).toBe(1); expect(ledger.rewardCount).toBe(1);
  });
  it('preserves historical free tasks and snapshots new task payment mode', async () => {
    const old = await claimedTask();
    service.config.VERIFICATION_PAYMENT_MODE = 'x402';
    await call('POST', `/v1/tasks/${old}/evidence`, 'worker', await uploaded(old)); await drain();
    expect((await call('GET', `/v1/tasks/${old}`)).json()).toMatchObject({ status: 'PAID', verificationPaymentMode: 'free_mock', x402PaymentStatus: 'not_performed' });
    expect((await call('POST', '/v1/x402/verify', 'agent', { taskId: old })).statusCode).toBe(409);
    const paid = await payableTask(); service.config.VERIFICATION_PAYMENT_MODE = 'free_mock'; await drain();
    expect((await call('GET', `/v1/tasks/${paid}`)).json().status).toBe('EVIDENCE_SUBMITTED');
    await offer(paid);
  });
  it('migration backfills legacy tasks without rewriting commitments or pending work', async () => {
    const initial = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
    const migration = await readFile(new URL('../migrations/003_verification_payments.sql', import.meta.url), 'utf8');
    await db.transaction(async tx => {
      await tx.query('SAVEPOINT legacy_probe');
      await tx.query('CREATE SCHEMA legacy_migration_probe');
      await tx.query('SET LOCAL search_path TO legacy_migration_probe');
      await tx.query(initial);
      const id = randomUUID(), agentId = randomUUID(), legacy = spec(), hash = hashJson(legacy);
      await tx.query("INSERT INTO principals(id,role,token_hash) VALUES ($1,'agent','legacy-token')", [agentId]);
      await tx.query("INSERT INTO tasks(id,agent_id,status,spec,spec_hash,reward_tinybars,expires_at) VALUES ($1,$2,'VERIFYING',$3,$4,500000000,now()+interval '1 hour')", [id, agentId, JSON.stringify(legacy), hash]);
      await tx.query("INSERT INTO jobs(kind,task_id,dedupe_key) VALUES ('verify',$1,'legacy-verify')", [id]);
      const message = { version: 1, taskId: id, taskSpecHash: hash };
      await tx.query("INSERT INTO hcs_events(id,task_id,type,payload,signed_bytes) VALUES ($1,$2,'TaskCreated',$3,$4)", [randomUUID(), id, JSON.stringify(message), Buffer.from('original-signed-bytes')]);
      await tx.query(migration);
      const task = (await tx.query('SELECT * FROM tasks WHERE id=$1', [id])).rows[0];
      expect(task).toMatchObject({ verification_payment_mode: 'free_mock', status: 'VERIFYING', spec: legacy, spec_hash: hash, reserved: true });
      expect(hashJson(task.spec)).toBe(hash);
      expect((await tx.query('SELECT payload,signed_bytes FROM hcs_events')).rows[0]).toEqual({ payload: message, signed_bytes: Buffer.from('original-signed-bytes') });
      expect((await tx.query('SELECT kind,status FROM jobs')).rows).toEqual([{ kind: 'verify', status: 'PENDING' }]);
      await tx.query('ROLLBACK TO SAVEPOINT legacy_probe');
    });
  });
  it.each([false, true])('CLI recovers lost authorization response (server persisted: %s) without signing again', async persisted => {
    const id = await payableTask(), directory = await mkdtemp(join(tmpdir(), 'fieldproof-client-'));
    const signatures: string[] = []; let loseResponse = true;
    vi.stubEnv('API_BASE_URL', config.API_BASE_URL); vi.stubEnv('AGENT_API_TOKEN', tokens.agent);
    vi.stubEnv('X402_PAY_TO_ACCOUNT_ID', config.X402_PAY_TO_ACCOUNT_ID!);
    vi.stubEnv('AGENT_HEDERA_ACCOUNT_ID', facilitator.payer);
    vi.stubEnv('AGENT_HEDERA_PRIVATE_KEY', facilitator.payerKey.toStringDer());
    vi.stubEnv('X402_JOURNAL_DIR', directory);
    vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
      const url = new URL(input), headers = new Headers(init.headers), signature = headers.get('payment-signature');
      if (signature) {
        signatures.push(signature);
        if (loseResponse && !persisted) { loseResponse = false; throw new Error('Simulated connection lost'); }
      }
      if (url.pathname.startsWith('/v1/x402/payments/')) await drain();
      const response = await app.inject({ method: (init.method ?? 'GET') as 'GET' | 'POST', url: url.pathname + url.search, headers: Object.fromEntries(headers.entries()), ...(init.body ? { payload: String(init.body) } : {}) });
      if (signature && loseResponse) { loseResponse = false; throw new Error('Simulated connection lost'); }
      return new Response(response.body, { status: response.statusCode, headers: response.headers as Record<string, string> });
    });
    try {
      await expect(buyVerification(id)).rejects.toThrow('Simulated connection lost');
      const path = join(directory, `${id}.json`), saved = await readFile(path, 'utf8');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      // Recovery succeeds even without the signing key: use the journal or persisted server operation.
      vi.stubEnv('AGENT_HEDERA_PRIVATE_KEY', '');
      expect((await buyVerification(id)).status).toBe('APPROVED');
      expect(await readFile(path, 'utf8')).toBe(saved);
      expect(new Set(signatures).size).toBe(1);
      expect(signatures.length).toBe(persisted ? 1 : 2);
      expect(facilitator.chargeCount).toBe(1); expect(ledger.rewardCount).toBe(1);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });
  it('refuses over-budget quotes and prevents access by another principal', async () => {
    const id = await payableTask(); service.config.X402_VERIFIER_PRICE_HBAR = '2';
    expect((await call('POST', '/v1/x402/verify', 'agent', { taskId: id })).json().error.code).toBe('VERIFICATION_BUDGET_EXCEEDED');
    expect((await call('POST', '/v1/x402/verify', 'worker', { taskId: id })).statusCode).toBe(403);
    expect(facilitator.chargeCount).toBe(0);
  });
  it('does not poison the purchase on an invalid signature and rejects altered recipients', async () => {
    const id = await payableTask(), { challenge, key } = await offer(id);
    const invalid = await authorize(id, await signed(challenge, true), key);
    expect(invalid.statusCode, invalid.body).toBe(402); expect(invalid.json().error).toBe('PAYMENT_SIGNATURE_INVALID');
    expect((await db.query('SELECT status FROM verification_payments WHERE task_id=$1', [id]))[0].status).toBe('QUOTED');
    const payload = await signed(challenge);
    expect((await authorize(id, { ...payload, accepted: { ...payload.accepted, payTo: '0.0.777' } }, key)).statusCode).toBe(402);
    expect((await authorize(id, payload, key)).statusCode).toBe(202); await drain(); expect(facilitator.chargeCount).toBe(1);
  });
  it('serializes concurrent authorizations and refuses a second signature', async () => {
    const id = await payableTask(), { challenge, key } = await offer(id), payload = await signed(challenge);
    const responses = await Promise.all([authorize(id, payload, key), authorize(id, payload, key)]);
    expect(responses.map(r => r.statusCode)).toEqual([202, 202]);
    expect((await authorize(id, await signed(challenge), key)).statusCode).toBe(409);
    const another = new Processor(service, new MockVerifierAdapter(), payments);
    for (let i = 0; i < 10; i++) await Promise.all([processor.tick(), another.tick()]);
    expect(facilitator.chargeCount).toBe(1); expect(facilitator.settleCalls).toBe(1); expect(ledger.rewardCount).toBe(1);
  });
  it('binds the signature and idempotency key to the original purchase', async () => {
    const first = await payableTask(), a = await offer(first), payload = await signed(a.challenge);
    expect((await authorize(first, payload, a.key)).statusCode).toBe(202); await drain();
    const second = await payableTask(), b = await offer(second);
    expect((await call('POST', '/v1/x402/verify', 'agent', { taskId: second }, a.key)).statusCode).toBe(409);
    const wrapped = { ...payload, accepted: b.challenge.accepts[0], resource: b.challenge.resource };
    expect((await authorize(second, wrapped, b.key)).json().error).toBe('PAYMENT_TRANSFER_MISMATCH');
    expect(facilitator.chargeCount).toBe(1);
  });
  it('reconciles a timeout after settlement without a second facilitator call', async () => {
    const id = await payableTask(), { challenge, key } = await offer(id);
    await authorize(id, await signed(challenge), key); facilitator.timeoutAfterCharge = true; await processor.tick();
    expect((await db.query('SELECT status FROM verification_payments WHERE task_id=$1', [id]))[0].status).toBe('UNKNOWN');
    expect((await call('GET', `/v1/tasks/${id}`)).json().status).toBe('EVIDENCE_SUBMITTED');
    await db.query("UPDATE jobs SET available_at=now() WHERE kind='x402_settle'");
    processor = new Processor(service, new MockVerifierAdapter(), payments); await drain();
    expect(facilitator.chargeCount).toBe(1); expect(facilitator.settleCalls).toBe(1);
    expect((await call('GET', `/v1/tasks/${id}`)).json().status).toBe('PAID');
    ledger.hideMirror = true; expect((await call('GET', `/v1/tasks/${id}/receipt/verify`)).json().checks.x402).toBe('pending_indexing');
  });
  it('does not verify or reward a failed settlement response', async () => {
    const id = await payableTask(), { challenge, key } = await offer(id);
    await authorize(id, await signed(challenge), key); facilitator.returnFailure = true; await drain();
    expect((await call('GET', `/v1/tasks/${id}`)).json()).toMatchObject({ status: 'EVIDENCE_SUBMITTED', x402PaymentStatus: 'unknown' });
    expect(ledger.rewardCount).toBe(0); expect(facilitator.chargeCount).toBe(0);
  });
  it('retries analysis after charging and charges rejected analysis without rewarding', async () => {
    service.config.MOCK_VERIFIER_SCENARIO = 'transient_error';
    const id = await payableTask(), a = await offer(id); await authorize(id, await signed(a.challenge), a.key); await drain();
    expect((await call('GET', `/v1/tasks/${id}`)).json().status).toBe('VERIFYING'); expect(facilitator.chargeCount).toBe(1);
    await db.query("UPDATE jobs SET available_at=now() WHERE kind='verify'"); await drain(); expect(facilitator.chargeCount).toBe(1); expect(ledger.rewardCount).toBe(1);
    service.config.MOCK_VERIFIER_SCENARIO = 'reject';
    const second = await payableTask(), b = await offer(second); await authorize(second, await signed(b.challenge), b.key); await drain();
    expect((await call('GET', `/v1/tasks/${second}/result`)).json().status).toBe('REJECTED'); expect(facilitator.chargeCount).toBe(2); expect(ledger.rewardCount).toBe(1);
  });
  it('requires available committed evidence and pins authorized evidence through recovery', async () => {
    service.config.VERIFICATION_PAYMENT_MODE = 'x402';
    const id = await claimedTask();
    expect((await call('POST', '/v1/x402/verify', 'agent', { taskId: id })).statusCode).toBe(409);
    await call('POST', `/v1/tasks/${id}/evidence`, 'worker', await uploaded(id));
    expect((await call('POST', '/v1/x402/verify', 'agent', { taskId: id })).json().error.code).toBe('EVIDENCE_NOT_COMMITTED');
    await drain(); const { challenge, key } = await offer(id); await authorize(id, await signed(challenge), key);
    await db.query("UPDATE evidence SET delete_after=now()-interval '1 second' WHERE task_id=$1", [id]); await processor.maintain();
    expect((await db.query('SELECT deleted_at FROM evidence WHERE task_id=$1', [id]))[0].deleted_at).toBeNull();
    await drain(); await processor.maintain(); expect((await db.query('SELECT deleted_at FROM evidence WHERE task_id=$1', [id]))[0].deleted_at).not.toBeNull();
  });
  it('creates a DRAFT until HCS confirmation and rejects over-allocation', async () => {
    const response = await call('POST', '/v1/tasks', 'agent', spec()); expect(response.json().status).toBe('DRAFT');
    expect((await call('POST', `/v1/tasks/${response.json().id}/claim`, 'worker', {})).statusCode).toBe(409);
    ledger.funds = 600_000_000n;
    expect((await call('POST', '/v1/tasks', 'agent', spec())).json().error.code).toBe('INSUFFICIENT_REWARD_BUDGET');
    await processor.tick(); expect((await call('GET', `/v1/tasks/${response.json().id}`)).json().status).toBe('OPEN');
  });
  it('publishes discoverable OpenAPI and rejects unrecognized input fields', async () => {
    const docs = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(docs.statusCode).toBe(200); expect(docs.json().paths['/v1/tasks']).toBeTruthy();
    expect(docs.json().paths['/v1/x402/verify']).toBeTruthy();
    expect((await call('POST', '/v1/tasks', 'agent', { ...spec(), verificationMode: 'real' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
  });
  it('returns identical idempotent responses and rejects changed payload', async () => {
    const key = randomUUID(), body = spec();
    const responses = await Promise.all([call('POST', '/v1/tasks', 'agent', body, key), call('POST', '/v1/tasks', 'agent', body, key)]);
    expect(responses[0]!.json()).toEqual(responses[1]!.json()); expect((await db.query('SELECT count(*) FROM tasks'))[0].count).toBe('1');
    expect((await call('POST', '/v1/tasks', 'agent', { ...body, title: 'changed' }, key)).statusCode).toBe(409);
  });
  it('allows exactly one concurrent claim and freezes the recipient', async () => {
    const id = await openTask();
    const results = await Promise.all([call('POST', `/v1/tasks/${id}/claim`, 'worker', {}), call('POST', `/v1/tasks/${id}/claim`, 'other', {})]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
    const winner = results[0]!.statusCode === 200 ? 'worker' : 'other';
    expect((await call('PUT', `/v1/workers/${ids[winner]}/payout-account`, winner, { hederaAccountId: '0.0.301' })).statusCode).toBe(200);
    expect((await db.query('SELECT payout_account_id FROM claims WHERE task_id=$1', [id]))[0].payout_account_id).toBe('0.0.300');
  });
  it('cancels only open tasks owned by the requester and releases reservations', async () => {
    const id = await openTask();
    expect((await call('POST', `/v1/tasks/${id}/cancel`, 'worker', {})).statusCode).toBe(403);
    expect((await call('POST', `/v1/tasks/${id}/cancel`, 'agent', {})).statusCode).toBe(200);
    expect((await db.query('SELECT reserved FROM tasks WHERE id=$1', [id]))[0].reserved).toBe(false);
    expect((await call('POST', `/v1/tasks/${id}/claim`, 'worker', {})).statusCode).toBe(409);
  });
  it('enforces ownership and validates account existence', async () => {
    const id = await claimedTask();
    expect((await app.inject({ method: 'GET', url: '/v1/tasks' })).statusCode).toBe(401);
    expect((await call('GET', `/v1/tasks/${id}/result`, 'other')).statusCode).toBe(403);
    expect((await call('PUT', `/v1/workers/${ids.worker}/payout-account`, 'worker', { hederaAccountId: '0.0.999' })).statusCode).toBe(400);
    expect((await call('PUT', `/v1/workers/${ids.worker}/payout-account`, 'other', { hederaAccountId: '0.0.301' })).statusCode).toBe(403);
  });
  it('completes the mock flow, reconciles lost responses, and never pays twice', async () => {
    const id = await claimedTask(), body = await uploaded(id), key = randomUUID();
    const response = await call('POST', `/v1/tasks/${id}/evidence`, 'worker', body, key); expect(response.statusCode, response.body).toBe(202);
    ledger.throwAfterSubmit = true;
    await drain();
    expect((await call('GET', `/v1/tasks/${id}`)).json().status).toBe('PAID');
    expect((await call('POST', `/v1/tasks/${id}/evidence`, 'worker', body, key)).json()).toEqual(response.json());
    await db.query("UPDATE jobs SET status='PENDING',available_at=now() WHERE kind='reward'"); await drain(); expect(ledger.rewardCount).toBe(1);
    const receipt = (await call('GET', `/v1/tasks/${id}/receipt/verify`)).json();
    expect(receipt.status).toBe('verified_mock_flow'); expect(receipt.checks.x402).toBe('not_performed'); expect(receipt.hcs).toHaveLength(4);
    ledger.hideMirror = true; expect((await call('GET', `/v1/tasks/${id}/receipt/verify`)).json().status).toBe('pending_indexing');
  });
  it('rejects changed bytes and leaves the task correctable', async () => {
    const id = await claimedTask(), body = await uploaded(id);
    const upload = (await db.query('SELECT * FROM uploads WHERE id=$1', [body.files[0].uploadId]))[0];
    await s3.send(new PutObjectCommand({ Bucket: config.OBJECT_STORAGE_BUCKET, Key: upload.storage_key, Body: imageB }));
    expect((await call('POST', `/v1/tasks/${id}/evidence`, 'worker', body)).statusCode).toBe(400);
    expect((await call('GET', `/v1/tasks/${id}`)).json().status).toBe('CLAIMED');
  });
  it('never lets a staging overwrite change committed evidence', async () => {
    const id = await claimedTask(), body = await uploaded(id);
    expect((await call('POST', `/v1/tasks/${id}/evidence`, 'worker', body)).statusCode).toBe(202);
    const upload = (await db.query('SELECT storage_key FROM uploads WHERE id=$1', [body.files[0].uploadId]))[0];
    await storage.write(upload.storage_key, imageB); await drain();
    const receipt = (await call('GET', `/v1/tasks/${id}/receipt/verify`)).json();
    expect(receipt.checks.fileHashes).toBe('verified'); expect(receipt.status).toBe('verified_mock_flow');
  });
  it('rejects wrong QR and reused photographs without issuing rewards', async () => {
    const first = await claimedTask(), a = await uploaded(first); a.qrHash = sha256('wrong');
    expect((await call('POST', `/v1/tasks/${first}/evidence`, 'worker', a)).statusCode).toBe(202); await drain();
    expect((await call('GET', `/v1/tasks/${first}/result`)).json().status).toBe('REJECTED');
    const second = await claimedTask(), b = await uploaded(second);
    await call('POST', `/v1/tasks/${second}/evidence`, 'worker', b); await drain();
    expect((await call('GET', `/v1/tasks/${second}/result`)).json().checks.exactDuplicateDetected).toBe(true); expect(ledger.rewardCount).toBe(0);
  });
  it('expires claims and rejects incomplete evidence', async () => {
    const id = await claimedTask(), body = await uploaded(id);
    expect((await call('POST', `/v1/tasks/${id}/evidence`, 'worker', { ...body, files: body.files.slice(0,1) })).statusCode).toBe(400);
    await db.query("UPDATE tasks SET expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    expect((await call('POST', `/v1/tasks/${id}/evidence`, 'worker', body)).statusCode).toBe(409);
    await processor.maintain(); expect((await call('GET', `/v1/tasks/${id}`)).json().status).toBe('EXPIRED');
  });
  it('does not pay manual review', async () => {
    service.config.MOCK_VERIFIER_SCENARIO = 'manual_review';
    const id = await claimedTask(), body = await uploaded(id); await call('POST', `/v1/tasks/${id}/evidence`, 'worker', body); await drain();
    expect((await call('GET', `/v1/tasks/${id}/result`)).json().status).toBe('MANUAL_REVIEW'); expect(ledger.rewardCount).toBe(0);
  });
  it('keeps a technical verifier error retryable and resumes without changing the payment count', async () => {
    service.config.MOCK_VERIFIER_SCENARIO = 'transient_error';
    const id = await claimedTask(), body = await uploaded(id); await call('POST', `/v1/tasks/${id}/evidence`, 'worker', body);
    await drain();
    expect((await call('GET', `/v1/tasks/${id}`)).json().status).toBe('VERIFYING');
    expect((await call('GET', `/v1/tasks/${id}/result`)).json()).toMatchObject({ status: 'RETRYING', operationalError: 'MOCK_TRANSIENT_ERROR' });
    await db.query("UPDATE jobs SET available_at=now() WHERE kind='verify'"); await drain();
    expect((await call('GET', `/v1/tasks/${id}`)).json().status).toBe('PAID'); expect(ledger.rewardCount).toBe(1);
  });
  it('detects file tampering in receipts and reports retention deletion explicitly', async () => {
    const id = await claimedTask(), body = await uploaded(id); await call('POST', `/v1/tasks/${id}/evidence`, 'worker', body); await drain();
    const file = (await db.query('SELECT storage_key FROM evidence_files WHERE task_id=$1 AND type=$2', [id, 'asset_overview']))[0];
    await storage.write(file.storage_key, imageB);
    expect((await call('GET', `/v1/tasks/${id}/receipt/verify`)).json().checks.fileHashes).toBe('mismatch');
    await db.query("UPDATE evidence SET delete_after=now()-interval '1 second' WHERE task_id=$1", [id]); await processor.maintain();
    const receipt = (await call('GET', `/v1/tasks/${id}/receipt/verify`)).json();
    expect(receipt.filesAvailable).toBe(false); expect(receipt.checks.fileHashes).toBe('deleted_by_retention');
    await expect(storage.read(file.storage_key)).rejects.toMatchObject({ name: 'NoSuchKey' });
  });
  it('cleans private copies left by a rolled back submission', async () => {
    const id = await claimedTask(), body = await uploaded(id);
    const second = (await db.query('SELECT * FROM uploads WHERE id=$1', [body.files[1].uploadId]))[0];
    await storage.delete(second.storage_key);
    expect((await call('POST', `/v1/tasks/${id}/evidence`, 'worker', body)).statusCode).toBe(400);
    expect((await db.query('SELECT count(*) FROM evidence WHERE task_id=$1', [id]))[0].count).toBe('0');
    const orphan = (await db.query('SELECT * FROM private_objects WHERE task_id=$1', [id]))[0]; expect(orphan).toBeTruthy();
    await db.query("UPDATE private_objects SET created_at=now()-interval '25 hours' WHERE task_id=$1", [id]); await processor.maintain();
    await expect(storage.read(orphan.storage_key)).rejects.toMatchObject({ name: 'NoSuchKey' });
  });
  it('two workers process the same queue without duplicating rewards', async () => {
    const id = await claimedTask(), body = await uploaded(id); await call('POST', `/v1/tasks/${id}/evidence`, 'worker', body);
    const second = new Processor(service, new MockVerifierAdapter());
    for (let i = 0; i < 10; i++) await Promise.all([processor.tick(), second.tick()]);
    expect((await call('GET', `/v1/tasks/${id}`)).json().status).toBe('PAID'); expect(ledger.rewardCount).toBe(1);
  });
  it('blocks repeated ambiguous operations and allows only the operator to retry the original ID', async () => {
    ledger.ambiguous = true;
    const created = await call('POST', '/v1/tasks', 'agent', spec()); const id = created.json().id;
    for (let i = 0; i < 10; i++) { await db.query("UPDATE jobs SET available_at=now() WHERE status='PENDING'"); await processor.tick(); }
    const job = (await db.query('SELECT * FROM jobs WHERE task_id=$1', [id]))[0]; expect(job.status).toBe('BLOCKED');
    const originalId = (await db.query('SELECT transaction_id FROM hcs_events WHERE task_id=$1', [id]))[0].transaction_id;
    expect((await call('POST', `/v1/operator/jobs/${job.id}/retry`, 'agent', {})).statusCode).toBe(403);
    expect((await call('POST', `/v1/operator/jobs/${job.id}/retry`, 'operator', {})).statusCode).toBe(202);
    ledger.ambiguous = false; await processor.tick();
    expect((await call('GET', `/v1/tasks/${id}`)).json().status).toBe('OPEN');
    expect((await db.query('SELECT transaction_id FROM hcs_events WHERE task_id=$1', [id]))[0].transaction_id).toBe(originalId);
  });
  it('recovers a prepared reward after restart without preparing another transaction', async () => {
    const id = await claimedTask(), body = await uploaded(id); await call('POST', `/v1/tasks/${id}/evidence`, 'worker', body);
    await processor.tick(); await processor.tick(); await processor.tick();
    ledger.ambiguous = true; await processor.tick();
    const operation = (await db.query('SELECT * FROM economic_operations WHERE task_id=$1', [id]))[0]; expect(operation.transaction_id).toBeTruthy();
    expect((await call('GET', `/v1/tasks/${id}`)).json().status).toBe('APPROVED');
    ledger.ambiguous = false;
    // The network accepted the bytes while the process was unavailable.
    await ledger.submit(operation.signed_bytes);
    await db.query("UPDATE jobs SET available_at=now() WHERE kind='reward'");
    processor = new Processor(service, new MockVerifierAdapter()); await drain();
    expect(ledger.rewardCount).toBe(1); expect((await db.query('SELECT transaction_id FROM economic_operations WHERE task_id=$1', [id]))[0].transaction_id).toBe(operation.transaction_id);
  });
  it('retries RewardPaid publication independently of the confirmed payment', async () => {
    const id = await claimedTask(), body = await uploaded(id); await call('POST', `/v1/tasks/${id}/evidence`, 'worker', body);
    ledger.failEvent = 'RewardPaid'; await drain();
    expect((await call('GET', `/v1/tasks/${id}`)).json().status).toBe('PAID'); expect(ledger.rewardCount).toBe(1);
    ledger.failEvent = undefined; await db.query("UPDATE jobs SET available_at=now() WHERE status='PENDING'"); await drain();
    expect((await call('GET', `/v1/tasks/${id}/receipt/verify`)).json().status).toBe('verified_mock_flow'); expect(ledger.rewardCount).toBe(1);
  });
});
