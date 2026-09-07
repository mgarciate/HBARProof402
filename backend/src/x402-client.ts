import { AccountId, Client, Hbar, PrivateKey, TransactionId, TransferTransaction, type ClientHederaSigner } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { accountId, AppError, tinybars } from './domain.js';
import { requirementsSchema } from './x402-protocol.js';

export function selectRequirements(challenge: PaymentRequired, budgetHbar: string, expectedRecipient: string, expectedOrigin: string): PaymentRequirements {
  if (challenge.x402Version !== 2 || new URL(challenge.resource.url).origin !== new URL(expectedOrigin).origin) throw new AppError(400, 'UNTRUSTED_PAYMENT_RESOURCE', 'Payment resource does not match the configured server');
  const requirements = challenge.accepts.map(r => requirementsSchema.safeParse(r)).find(r => r.success && r.data.payTo === expectedRecipient);
  if (!requirements?.success) throw new AppError(400, 'UNTRUSTED_PAYMENT_RECIPIENT', 'No supported testnet HBAR offer for the expected recipient');
  if (BigInt(requirements.data.amount) > tinybars(budgetHbar)) throw new AppError(409, 'VERIFICATION_BUDGET_EXCEEDED', 'Agent refused a price above its task budget');
  return requirements.data;
}

/** SDK extension point: signs the purchase memo as well as the exact transfer. Never submits. */
export function purchaseSigner(payer: string, privateKey: PrivateKey): ClientHederaSigner {
  accountId.parse(payer);
  return { accountId: payer, async createPartiallySignedTransferTransaction(input) {
    const requirements = requirementsSchema.parse(input);
    if ([requirements.payTo, requirements.extra.feePayer].includes(payer)) throw new Error('Agent payer must differ from verifier and facilitator');
    const client = Client.forTestnet().setDefaultRegenerateTransactionId(false);
    try {
      const transfer = new TransferTransaction()
        .setTransactionId(TransactionId.generate(AccountId.fromString(requirements.extra.feePayer)))
        .setRegenerateTransactionId(false).setTransactionValidDuration(requirements.maxTimeoutSeconds)
        .setTransactionMemo(requirements.extra.memo)
        .addHbarTransfer(payer, Hbar.fromTinybars(`-${requirements.amount}`))
        .addHbarTransfer(requirements.payTo, Hbar.fromTinybars(requirements.amount))
        .freezeWith(client);
      await transfer.sign(privateKey);
      return Buffer.from(transfer.toBytes()).toString('base64');
    } finally { client.close(); }
  } };
}

export async function signPurchase(challenge: PaymentRequired, requirements: PaymentRequirements, signer: ClientHederaSigner): Promise<PaymentPayload> {
  const signed = await new ExactHederaScheme(signer).createPaymentPayload(2, requirements);
  return { x402Version: 2, resource: challenge.resource, accepted: requirements, payload: signed.payload };
}
