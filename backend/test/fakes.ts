import type { Ledger, Prepared, Confirmation } from '../src/hedera.js';
import type { HcsEvent } from '../src/domain.js';
import type { Facilitator } from '../src/x402-protocol.js';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { inspectHederaTransaction, PrivateKey, Transaction } from '@x402/hedera';

/** Test-only ledger. Runtime never imports this module. */
export class FakeLedger implements Ledger {
  operatorId = '0.0.100'; topicId = '0.0.200'; funds = 100_000_000_000n;
  prepared = new Map<string, any>(); confirmed = new Map<string, any>();
  rewardCount = 0; throwAfterSubmit = false; hideMirror = false; ambiguous = false; failEvent?: string;
  async accountExists(id: string) { return id !== '0.0.999'; }
  async balance() { return this.funds; }
  private prepare(data: any): Prepared {
    const id = `0.0.100@${Math.floor(Date.now() / 1000)}.${this.prepared.size.toString().padStart(9, '0')}`;
    this.prepared.set(id, data); return { transactionId: id, bytes: Buffer.from(id) };
  }
  async prepareMessage(event: HcsEvent) { return this.prepare({ event }); }
  async prepareReward(taskId: string, recipient: string, amount: string) { return this.prepare({ taskId, recipient, amount }); }
  async submit(bytes: Buffer) {
    const id = bytes.toString(); if (this.confirmed.has(id)) return;
    const data = this.prepared.get(id);
    if (this.ambiguous || (this.failEvent && data.event?.type === this.failEvent)) throw new Error('NETWORK_TIMEOUT');
    const sequence = String(this.confirmed.size + 1);
    this.confirmed.set(id, { ...data, sequence });
    if (!data.event) { this.rewardCount++; this.funds -= BigInt(data.amount); }
    if (this.throwAfterSubmit) throw new Error('NETWORK_TIMEOUT');
  }
  async confirm(id: string): Promise<Confirmation> { const tx = this.confirmed.get(id); return tx ? { status: 'SUCCESS', sequence: tx.event ? tx.sequence : undefined } : { status: 'PENDING' }; }
  async mirrorTransaction(id: string) {
    const tx = this.confirmed.get(id); if (!tx || this.hideMirror) return null;
    if (tx.payment) return { result: 'SUCCESS', name: 'CRYPTOTRANSFER', memo_base64: Buffer.from(tx.memo).toString('base64'), transfers: [{ account: tx.recipient, amount: tx.amount }, { account: tx.payer, amount: `-${tx.amount}` }] };
    return { result: 'SUCCESS', memo_base64: Buffer.from(`fieldproof:${tx.taskId}`).toString('base64'), transfers: tx.event ? [] : [{ account: tx.recipient, amount: tx.amount }, { account: this.operatorId, amount: `-${tx.amount}` }] };
  }
  async mirrorMessage(sequence: string) {
    if (this.hideMirror) return null;
    const tx = [...this.confirmed.values()].find(t => t.sequence === sequence && t.event);
    return tx ? { message: Buffer.from(JSON.stringify(tx.event)).toString('base64'), consensus_timestamp: '1788775200.000000001' } : null;
  }
  close() {}
}

export class FakeFacilitator implements Facilitator {
  readonly payerKey = PrivateKey.generateED25519();
  readonly payer = '0.0.500';
  chargeCount = 0; settleCalls = 0; verifyCalls = 0;
  timeoutAfterCharge = false; unavailable = false; returnFailure = false;
  constructor(private ledger: FakeLedger) {}
  async supported() { return { feePayer: '0.0.600' }; }
  async verify(_url: string, payload: PaymentPayload, _requirements: PaymentRequirements) {
    this.verifyCalls++;
    const tx = Transaction.fromBytes(Buffer.from(payload.payload.transaction as string, 'base64'));
    return { isValid: this.payerKey.publicKey.verifyTransaction(tx), payer: this.payer };
  }
  async settle(_url: string, payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls++;
    if (this.unavailable) throw new Error('FACILITATOR_TIMEOUT');
    const inspected = inspectHederaTransaction(payload.payload.transaction as string);
    if (this.returnFailure) return { success: false, transaction: inspected.transactionId, network: 'hedera:testnet', payer: this.payer };
    if (!this.ledger.confirmed.has(inspected.transactionId)) {
      this.chargeCount++;
      this.ledger.confirmed.set(inspected.transactionId, { payment: true, payer: this.payer, recipient: requirements.payTo, amount: requirements.amount, memo: requirements.extra.memo });
    }
    if (this.timeoutAfterCharge) throw new Error('FACILITATOR_TIMEOUT');
    return { success: true, transaction: inspected.transactionId, network: 'hedera:testnet', payer: this.payer };
  }
}
