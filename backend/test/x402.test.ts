import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrivateKey, Transaction, TransferTransaction } from '@x402/hedera';
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { Blocky402Facilitator, decodeAuthorization, inspectAuthorization, matchesPaymentTransfer } from '../src/x402-protocol.js';
import { purchaseSigner, selectRequirements, signPurchase } from '../src/x402-client.js';
import { hcsEventSchema, sha256 } from '../src/domain.js';
import { preflight } from '../scripts/x402-preflight.js';

function quote(): PaymentRequired {
  const id = randomUUID();
  return { x402Version: 2, resource: { url: `https://fieldproof.test/v1/x402/verify?purchaseId=${id}`, mimeType: 'application/json' }, accepts: [{ scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0', amount: '100000', payTo: '0.0.400', maxTimeoutSeconds: 120, extra: { feePayer: '0.0.600', memo: `fieldproof:x402:${id}` } }] };
}
afterEach(() => vi.unstubAllGlobals());
describe('x402 signing and budget policy', () => {
  it('round trips standard v2 headers and signs the purchase memo and exact tinybars', async () => {
    const challenge = decodePaymentRequiredHeader(encodePaymentRequiredHeader(quote()));
    const requirements = selectRequirements(challenge, '0.01', '0.0.400', 'https://fieldproof.test');
    const key = PrivateKey.generateED25519(), payload = await signPurchase(challenge, requirements, purchaseSigner('0.0.500', key));
    const decoded = decodeAuthorization(encodePaymentSignatureHeader(payload));
    const inspected = inspectAuthorization(decoded, requirements, challenge.resource);
    expect(inspected.payer).toBe('0.0.500'); expect(inspected.transactionId.startsWith('0.0.600@')).toBe(true);
    const tx = Transaction.fromBytes(Buffer.from(payload.payload.transaction as string, 'base64')) as TransferTransaction;
    expect(key.publicKey.verifyTransaction(tx)).toBe(true); expect(tx.transactionMemo).toBe(requirements.extra.memo);
    expect(tx.hbarTransfers.get('0.0.400')!.toTinybars().toString()).toBe('100000');
  });
  it('supports ECDSA payer signatures without submitting a transfer', async () => {
    const challenge = quote(), key = PrivateKey.generateECDSA();
    const payload = await signPurchase(challenge, challenge.accepts[0]!, purchaseSigner('0.0.500', key));
    const tx = Transaction.fromBytes(Buffer.from(payload.payload.transaction as string, 'base64'));
    expect(key.publicKey.verifyTransaction(tx)).toBe(true);
  });
  it('refuses excessive price, other networks, other recipients and other origins before signing', () => {
    const challenge = quote();
    expect(() => selectRequirements(challenge, '0.0001', '0.0.400', 'https://fieldproof.test')).toThrow('budget');
    expect(() => selectRequirements(challenge, '1', '0.0.999', 'https://fieldproof.test')).toThrow('recipient');
    expect(() => selectRequirements(challenge, '1', '0.0.400', 'https://other.test')).toThrow('server');
    challenge.accepts[0]!.network = 'hedera:mainnet';
    expect(() => selectRequirements(challenge, '1', '0.0.400', 'https://fieldproof.test')).toThrow('recipient');
  });
  it('rejects tampered requirements and malformed payment headers', async () => {
    expect(() => decodeAuthorization('not json')).toThrow('Invalid x402');
    const challenge = quote(), requirements = challenge.accepts[0]!;
    const payload = await signPurchase(challenge, requirements, purchaseSigner('0.0.500', PrivateKey.generateED25519()));
    expect(() => inspectAuthorization({ ...payload, accepted: { ...requirements, amount: '1' } }, requirements, challenge.resource)).toThrow('quote');
    const second = quote();
    expect(() => inspectAuthorization({ ...payload, accepted: second.accepts[0]!, resource: second.resource }, second.accepts[0]!, second.resource)).toThrow('purchase');
  });
  it('compares mirror transfers exactly and checks the signed purchase memo', () => {
    const requirements = quote().accepts[0]!;
    const payment = { recipient: '0.0.400', payer: '0.0.500', amount_tinybars: '9007199254740993', requirements };
    const tx = { result: 'SUCCESS', name: 'CRYPTOTRANSFER', memo_base64: Buffer.from(requirements.extra.memo as string).toString('base64'), transfers: [{ account: payment.payer, amount: '-9007199254740993' }, { account: payment.recipient, amount: '9007199254740993' }] };
    expect(matchesPaymentTransfer(tx, payment)).toBe(true);
    expect(matchesPaymentTransfer({ ...tx, memo_base64: '' }, payment)).toBe(false);
    expect(matchesPaymentTransfer(tx, { ...payment, amount_tinybars: '9007199254740992' })).toBe(false);
  });
  it('accepts paid HCS v2 and historical v1 without pretending vision is real', () => {
    const event = { version: 2, type: 'VerificationCompleted', eventId: randomUUID(), taskId: randomUUID(), timestamp: new Date().toISOString(), result: 'APPROVED', verifierVersion: 'mock-bike-visual-v1', verificationMode: 'mock', evidenceAggregateHash: sha256('e'), x402PaymentReferenceHash: sha256('payment') };
    expect(hcsEventSchema.safeParse(event).success).toBe(true);
    const { x402PaymentReferenceHash: _unused, ...old } = event;
    expect(hcsEventSchema.safeParse({ ...old, version: 1 }).success).toBe(true);
    expect(hcsEventSchema.safeParse({ ...event, version: 1 }).success).toBe(false);
  });
});

describe('Blocky402 HTTP adapter', () => {
  it('discovers a dynamic fee payer and sends canonical v2 verify/settle requests', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'hedera:testnet', extra: { feePayer: '0.0.123' } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ isValid: true, payer: '0.0.500' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, transaction: '0.0.123@1.000000001', network: 'hedera:testnet', payer: '0.0.500' })));
    vi.stubGlobal('fetch', request);
    const adapter = new Blocky402Facilitator(), challenge = quote();
    expect(await adapter.supported('https://facilitator.test')).toEqual({ feePayer: '0.0.123' });
    const payload = await signPurchase(challenge, challenge.accepts[0]!, purchaseSigner('0.0.500', PrivateKey.generateED25519()));
    expect((await adapter.verify('https://facilitator.test', payload, challenge.accepts[0]!)).isValid).toBe(true);
    expect((await adapter.settle('https://facilitator.test', payload, challenge.accepts[0]!)).success).toBe(true);
    expect(request.mock.calls[1]![0]).toBe('https://facilitator.test/verify');
    const options = request.mock.calls[1]![1];
    expect(JSON.parse(options.body)).toEqual({ x402Version: 2, paymentPayload: payload, paymentRequirements: challenge.accepts[0] });
    expect(options.redirect).toBe('error');
  });
  it('fails closed for unsupported networks, malformed success and HTTP failures', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ kinds: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true })))
      .mockResolvedValueOnce(new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', request); const adapter = new Blocky402Facilitator();
    await expect(adapter.supported('https://facilitator.test')).rejects.toThrow('advertise');
    await expect(adapter.settle('https://facilitator.test', {} as any, {} as PaymentRequirements)).rejects.toThrow();
    await expect(adapter.supported('https://facilitator.test')).rejects.toThrow('Blocky402');
  });
});

describe('real testnet preflight', () => {
  function fixture() {
    const operator = PrivateKey.generateED25519(), agent = PrivateKey.generateED25519();
    const environment = {
      HEDERA_NETWORK: 'testnet', HEDERA_OPERATOR_ID: '0.0.100', HEDERA_OPERATOR_KEY: operator.toStringDer(), HEDERA_HCS_TOPIC_ID: '0.0.200',
      HEDERA_MIRROR_NODE_URL: 'https://mirror.test', HEDERA_FEE_RESERVE_HBAR: '2', VERIFICATION_PAYMENT_MODE: 'x402',
      BLOCKY402_BASE_URL: 'https://blocky.test', X402_VERIFIER_PRICE_HBAR: '0.001', X402_PAY_TO_ACCOUNT_ID: '0.0.300',
      AGENT_HEDERA_ACCOUNT_ID: '0.0.400', AGENT_HEDERA_PRIVATE_KEY: agent.toStringDer(), DEMO_PAYOUT_ACCOUNT_ID: '0.0.500',
      AGENT_API_TOKEN: 'a'.repeat(32), WORKER_API_TOKEN: 'w'.repeat(32), API_BASE_URL: 'https://api.test',
    };
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname === 'blocky.test') return Response.json({ kinds: [
        { x402Version: 2, scheme: 'exact', network: 'solana:devnet', extra: { feePayer: '8YmzSolanaAddress' } },
        { x402Version: 2, scheme: 'exact', network: 'hedera:testnet', extra: { feePayer: '0.0.600' } },
      ] });
      if (url.pathname.startsWith('/api/v1/accounts/')) {
        const id = url.pathname.split('/').at(-1)!;
        const keys: Record<string, string | undefined> = { '0.0.100': operator.publicKey.toStringRaw(), '0.0.400': agent.publicKey.toStringRaw() };
        return Response.json({ account: id, balance: { balance: id === '0.0.100' ? 300_000_000 : 1_000_000 }, ...(keys[id] ? { key: { key: keys[id] } } : {}) });
      }
      if (url.pathname.startsWith('/api/v1/topics/')) return Response.json({ topic_id: '0.0.200' });
      if (url.pathname === '/health/ready') return Response.json({ status: 'ready' });
      if (url.pathname === '/v1/me') return Response.json({ role: (init?.headers as Record<string, string> | undefined)?.Authorization?.endsWith('a'.repeat(32)) ? 'agent' : 'worker' });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    return { environment, operator, agent, fetcher };
  }
  it('checks public keys, balances, roles, topic and dynamic facilitator before signing', async () => {
    const { environment, fetcher } = fixture();
    const report = await preflight(environment, fetcher);
    expect(report).toMatchObject({ network: 'hedera:testnet', facilitatorFeePayer: '0.0.600', priceTinybars: '100000', apiReady: true, seededRoles: ['agent', 'worker'] });
    expect(report.accounts.find(account => account.role === 'agent')).toMatchObject({ id: '0.0.400', keyMatched: true });
    expect(JSON.stringify(report)).not.toContain(environment.AGENT_HEDERA_PRIVATE_KEY);
  });
  it('fails closed when a private key does not belong to its configured account', async () => {
    const { environment, fetcher } = fixture();
    environment.AGENT_HEDERA_PRIVATE_KEY = PrivateKey.generateED25519().toStringDer();
    await expect(preflight(environment, fetcher)).rejects.toThrow('PREFLIGHT_PRIVATE_KEY_MISMATCH:agent');
  });
});
