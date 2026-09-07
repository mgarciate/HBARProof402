import 'dotenv/config';
import { Client, PrivateKey, TopicCreateTransaction } from '@hiero-ledger/sdk';
if (process.env.HEDERA_NETWORK !== 'testnet') throw new Error('HEDERA_NETWORK must be testnet');
const key = PrivateKey.fromString(process.env.HEDERA_OPERATOR_KEY!);
const client = Client.forTestnet().setOperator(process.env.HEDERA_OPERATOR_ID!, key);
try {
  const response = await new TopicCreateTransaction().setTopicMemo('FieldProof402 testnet receipts (mock verifier)').setSubmitKey(key.publicKey).setAdminKey(key.publicKey).execute(client);
  const receipt = await response.getReceipt(client);
  console.log(`HEDERA_HCS_TOPIC_ID=${receipt.topicId!.toString()}`);
  console.log(`Transaction: ${response.transactionId.toString()}`);
} finally { client.close(); }
