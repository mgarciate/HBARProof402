import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrivateKey, Transaction, TransferTransaction, TopicMessageSubmitTransaction } from '@hiero-ledger/sdk';
import { HederaLedger } from '../src/hedera.js';
import { sha256 } from '../src/domain.js';
import type { Config } from '../src/config.js';

describe('Hedera SDK offline transaction preparation', () => {
  it('persists signed rewards with exact tinybars, recipient, memo and transaction ID', async () => {
    const ledger = new HederaLedger({ HEDERA_OPERATOR_ID: '0.0.100', HEDERA_OPERATOR_KEY: PrivateKey.generateED25519().toStringDer(), HEDERA_HCS_TOPIC_ID: '0.0.200', HEDERA_MIRROR_NODE_URL: 'https://testnet.mirrornode.hedera.com' } as Config);
    try {
      const taskId = randomUUID(), prepared = await ledger.prepareReward(taskId, '0.0.300', '500000001');
      const tx = Transaction.fromBytes(prepared.bytes) as TransferTransaction;
      expect(tx).toBeInstanceOf(TransferTransaction); expect(tx.transactionId!.toString()).toBe(prepared.transactionId);
      expect(tx.transactionMemo).toBe(`fieldproof:${taskId}`);
      expect(tx.hbarTransfers.get('0.0.300')!.toTinybars().toString()).toBe('500000001');
      expect(tx.hbarTransfers.get('0.0.100')!.toTinybars().toString()).toBe('-500000001');
    } finally { ledger.close(); }
  });
  it('serializes a one-message HCS commitment without leaking private fields', async () => {
    const ledger = new HederaLedger({ HEDERA_OPERATOR_ID: '0.0.100', HEDERA_OPERATOR_KEY: PrivateKey.generateED25519().toStringDer(), HEDERA_HCS_TOPIC_ID: '0.0.200', HEDERA_MIRROR_NODE_URL: 'https://testnet.mirrornode.hedera.com' } as Config);
    try {
      const event = { version: 1 as const, type: 'TaskCreated' as const, eventId: randomUUID(), taskId: randomUUID(), timestamp: new Date().toISOString(), taskSpecHash: sha256('spec'), rewardAsset: 'HBAR' as const, rewardAmount: '5', expiresAt: new Date(Date.now() + 60_000).toISOString(), policyVersion: 'bike-visual-v1' as const };
      const prepared = await ledger.prepareMessage(event);
      const tx = Transaction.fromBytes(prepared.bytes) as TopicMessageSubmitTransaction;
      expect(tx).toBeInstanceOf(TopicMessageSubmitTransaction); expect(tx.transactionId!.toString()).toBe(prepared.transactionId);
      expect(JSON.parse(Buffer.from(tx.message!).toString())).toEqual(event);
      expect(tx.topicId!.toString()).toBe('0.0.200');
    } finally { ledger.close(); }
  });
});
