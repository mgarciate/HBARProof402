import { AccountBalanceQuery, Client, Hbar, PrivateKey, Transaction, TransactionId, TransactionReceiptQuery, TopicMessageSubmitTransaction, TransferTransaction } from '@hiero-ledger/sdk';
import { createRequire } from 'node:module';
import type { Config } from './config.js';
import { AppError, hcsEventSchema, transactionPath, type HcsEvent } from './domain.js';

// Mirror Node encodes tinybars and sequences as JSON numbers; never round them through JS Number.
const mirrorJson: { parse: (text: string) => any } = createRequire(import.meta.url)('json-bigint')({ storeAsString: true, alwaysParseAsBig: true });

export type Prepared = { transactionId: string; bytes: Buffer };
export type Confirmation = { status: 'SUCCESS' | 'PENDING' | 'FAILED'; sequence?: string; reason?: string };
export interface Ledger {
  operatorId: string; topicId: string;
  accountExists(id: string): Promise<boolean>;
  balance(): Promise<bigint>;
  prepareMessage(event: HcsEvent): Promise<Prepared>;
  prepareReward(taskId: string, recipient: string, amount: string): Promise<Prepared>;
  submit(bytes: Buffer): Promise<void>;
  confirm(transactionId: string): Promise<Confirmation>;
  mirrorTransaction(transactionId: string): Promise<any | null>;
  mirrorMessage(sequence: string): Promise<any | null>;
  close(): void;
}
export class HederaLedger implements Ledger {
  readonly operatorId: string; readonly topicId: string;
  private client: Client; private key: PrivateKey;
  constructor(private config: Config) {
    this.operatorId = config.HEDERA_OPERATOR_ID; this.topicId = config.HEDERA_HCS_TOPIC_ID;
    this.key = PrivateKey.fromString(config.HEDERA_OPERATOR_KEY);
    this.client = Client.forTestnet().setOperator(this.operatorId, this.key);
    this.client.setDefaultRegenerateTransactionId(false);
    this.client.setRequestTimeout(20_000);
    this.client.setMaxAttempts(2);
  }
  private async mirror(path: string): Promise<any | null> {
    const response = await fetch(`${this.config.HEDERA_MIRROR_NODE_URL}${path}`, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new AppError(503, 'MIRROR_UNAVAILABLE', 'Mirror Node temporarily unavailable');
    return mirrorJson.parse(await response.text());
  }
  async accountExists(id: string): Promise<boolean> {
    const account = await this.mirror(`/api/v1/accounts/${encodeURIComponent(id)}`);
    return !!account && account.account === id && !account.deleted;
  }
  async balance(): Promise<bigint> {
    const balance = await new AccountBalanceQuery().setAccountId(this.operatorId).execute(this.client);
    return BigInt(balance.hbars.toTinybars().toString());
  }
  private async prepare(tx: Transaction): Promise<Prepared> {
    tx.setTransactionId(TransactionId.generate(this.operatorId));
    tx.setRegenerateTransactionId(false);
    tx.setTransactionValidDuration(120);
    tx.freezeWith(this.client);
    await tx.sign(this.key);
    return { transactionId: tx.transactionId!.toString(), bytes: Buffer.from(tx.toBytes()) };
  }
  async prepareMessage(event: HcsEvent): Promise<Prepared> {
    const message = JSON.stringify(hcsEventSchema.parse(event));
    if (Buffer.byteLength(message) > 1024) throw new Error('HCS event exceeds single-message limit');
    return this.prepare(new TopicMessageSubmitTransaction().setTopicId(this.topicId).setMessage(message).setMaxChunks(1));
  }
  async prepareReward(taskId: string, recipient: string, amount: string): Promise<Prepared> {
    if (recipient === this.operatorId) throw new Error('Operator cannot receive its own reward');
    return this.prepare(new TransferTransaction().setTransactionMemo(`fieldproof:${taskId}`)
      .addHbarTransfer(this.operatorId, Hbar.fromTinybars(`-${amount}`)).addHbarTransfer(recipient, Hbar.fromTinybars(amount)));
  }
  async submit(bytes: Buffer): Promise<void> { await Transaction.fromBytes(bytes).execute(this.client); }
  async confirm(transactionId: string): Promise<Confirmation> {
    try {
      const receipt = await new TransactionReceiptQuery().setTransactionId(TransactionId.fromString(transactionId)).setValidateStatus(false).execute(this.client);
      const status = receipt.status.toString();
      if (status === 'SUCCESS') return { status: 'SUCCESS', sequence: receipt.topicSequenceNumber?.toString() };
      if (!['UNKNOWN', 'RECEIPT_NOT_FOUND', 'RECORD_NOT_FOUND', 'DUPLICATE_TRANSACTION'].includes(status)) return { status: 'FAILED', reason: status };
    } catch { /* Receipt may have aged out. Reconcile against Mirror Node before any resend. */ }
    const tx = await this.mirrorTransaction(transactionId);
    if (!tx) return { status: 'PENDING' };
    if (tx.result !== 'SUCCESS') return { status: 'FAILED', reason: tx.result };
    let sequence: string | undefined;
    if (tx.name === 'CONSENSUSSUBMITMESSAGE') {
      const messages = await this.mirror(`/api/v1/topics/${this.topicId}/messages?timestamp=${encodeURIComponent(tx.consensus_timestamp)}&limit=1`);
      if (!messages?.messages?.[0]) return { status: 'PENDING' };
      sequence = String(messages.messages[0].sequence_number);
    }
    return { status: 'SUCCESS', sequence };
  }
  async mirrorTransaction(transactionId: string): Promise<any | null> {
    const result = await this.mirror(`/api/v1/transactions/${encodeURIComponent(transactionPath(transactionId))}`);
    const transactions = result?.transactions ?? [];
    // A duplicate submission is not the result of the original transaction.
    return transactions.find((tx: any) => tx.result === 'SUCCESS') ?? transactions.find((tx: any) => tx.result !== 'DUPLICATE_TRANSACTION') ?? null;
  }
  async mirrorMessage(sequence: string): Promise<any | null> { return this.mirror(`/api/v1/topics/${this.topicId}/messages/${sequence}`); }
  close(): void { this.client.close(); }
}
