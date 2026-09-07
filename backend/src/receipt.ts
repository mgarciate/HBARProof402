import { hashJson, sha256, transactionUrl } from './domain.js';
import type { Marketplace, Principal } from './service.js';
import { matchesPaymentTransfer } from './x402-protocol.js';

export async function verifyReceipt(service: Marketplace, principal: Principal, taskId: string): Promise<any> {
  const task = await service.authorizeRead(principal, taskId);
  const evidence = (await service.db.query('SELECT * FROM evidence WHERE task_id=$1', [taskId]))[0];
  const verification = (await service.db.query('SELECT result FROM verifications WHERE task_id=$1', [taskId]))[0]?.result;
  const reward = (await service.db.query('SELECT * FROM economic_operations WHERE task_id=$1', [taskId]))[0];
  const payment = (await service.db.query('SELECT * FROM verification_payments WHERE task_id=$1', [taskId]))[0];
  const events = await service.db.query('SELECT * FROM hcs_events WHERE task_id=$1 ORDER BY created_at', [taskId]);
  const checks: Record<string, string> = { taskSpecHash: hashJson(task.spec) === task.spec_hash ? 'verified' : 'mismatch', evidenceAggregateHash: evidence ? (hashJson(evidence.manifest) === evidence.aggregate_hash ? 'verified' : 'mismatch') : 'not_available', x402: 'not_performed', vision: 'mock' };
  checks.fileHashes = !evidence ? 'not_available' : evidence.deleted_at ? 'deleted_by_retention' : 'verified';
  if (evidence && !evidence.deleted_at) {
    const files = await service.db.query('SELECT * FROM evidence_files WHERE task_id=$1', [taskId]);
    const fileManifest = files.map(({ type, sha256 }) => ({ type, sha256 })).sort((a,b) => a.type.localeCompare(b.type));
    if (hashJson(fileManifest) !== hashJson(evidence.manifest.files)) checks.fileHashes = 'mismatch';
    try {
      for (const file of files) if (sha256(await service.storage.read(file.storage_key)) !== file.sha256) checks.fileHashes = 'mismatch';
    } catch { checks.fileHashes = 'unavailable'; }
  }
  const hcs = [];
  if (task.verification_payment_mode === 'x402') {
    checks.x402 = payment?.status === 'FAILED' ? 'failed' : 'pending_indexing';
    if (payment?.transaction_id) {
      try {
        const transaction = await service.ledger.mirrorTransaction(payment.transaction_id);
        if (transaction) checks.x402 = matchesPaymentTransfer(transaction, payment) && evidence?.aggregate_hash === payment.evidence_hash && (!verification || verification.x402PaymentReference === payment.transaction_id) ? 'verified' : 'mismatch';
      } catch { checks.x402 = 'unavailable'; }
    }
  }
  for (const event of events) {
    let state = 'pending_indexing'; let timestamp: string | null = null;
    if (event.status === 'FAILED') state = 'failed';
    else if (event.sequence) {
      try {
        const message = await service.ledger.mirrorMessage(event.sequence);
        if (message) {
          timestamp = message.consensus_timestamp;
          const actual = JSON.parse(Buffer.from(message.message, 'base64').toString('utf8'));
          let matches = hashJson(actual) === hashJson(event.payload);
          if (event.type === 'TaskCreated') matches &&= actual.taskSpecHash === hashJson(task.spec);
          if (event.type === 'EvidenceSubmitted') matches &&= !!evidence && actual.evidenceAggregateHash === hashJson(evidence.manifest);
          if (event.type === 'VerificationCompleted') matches &&= !!verification && !!evidence && actual.result === verification.status && actual.evidenceAggregateHash === hashJson(evidence.manifest) && actual.verifierVersion === verification.verifierVersion;
          if (event.type === 'VerificationCompleted' && task.verification_payment_mode === 'x402') matches &&= !!payment?.transaction_id && actual.version === 2 && actual.x402PaymentReferenceHash === sha256(payment.transaction_id);
          if (event.type === 'RewardPaid') matches &&= !!reward && actual.rewardTransactionReferenceHash === sha256(reward.transaction_id) && actual.amount === task.spec.reward.amount;
          state = matches ? 'verified' : 'mismatch';
        }
      } catch { state = 'unavailable'; }
    }
    hcs.push({ type: event.type, sequence: event.sequence, status: state, consensusTimestamp: timestamp, transactionId: event.transaction_id, hashscanUrl: event.transaction_id ? transactionUrl(event.transaction_id) : null });
  }
  checks.reward = reward ? 'pending_indexing' : ['REJECTED', 'MANUAL_REVIEW', 'CANCELLED', 'EXPIRED'].includes(task.status) ? 'not_applicable' : 'not_available';
  if (reward?.transaction_id) {
    try {
      const tx = await service.ledger.mirrorTransaction(reward.transaction_id);
      if (tx) {
        const transfers = tx.transfers ?? [];
        const credit = transfers.filter((t: any) => t.account === reward.recipient).reduce((sum: bigint, t: any) => sum + BigInt(t.amount), 0n);
        const debit = transfers.filter((t: any) => t.account === service.ledger.operatorId).reduce((sum: bigint, t: any) => sum + BigInt(t.amount), 0n);
        checks.reward = tx.result === 'SUCCESS' && credit === BigInt(reward.amount_tinybars) && debit <= -BigInt(reward.amount_tinybars) && Buffer.from(tx.memo_base64 ?? '', 'base64').toString() === `fieldproof:${taskId}` ? 'verified' : 'mismatch';
      }
    } catch { checks.reward = 'unavailable'; }
  }
  const states = [...Object.values(checks), ...hcs.map(e => e.status)];
  const complete = hcs.some(e => e.type === 'VerificationCompleted') && (task.status !== 'PAID' || hcs.some(e => e.type === 'RewardPaid'));
  const status = states.includes('mismatch') || states.includes('failed') ? 'mismatch' : states.includes('unavailable') ? 'unavailable' : !complete || states.some(s => ['pending_indexing', 'not_available'].includes(s)) ? 'pending_indexing' : 'verified_mock_flow';
  return { taskId, status, verificationMode: 'mock', x402PaymentStatus: payment?.status.toLowerCase() ?? (task.verification_payment_mode === 'x402' ? 'awaiting_payment' : 'not_performed'), x402Payment: payment ? { id: payment.id, transactionId: payment.transaction_id, hashscanUrl: payment.transaction_id ? transactionUrl(payment.transaction_id) : null } : null, checks, result: verification ?? null, filesAvailable: evidence ? !evidence.deleted_at : false, hcs, reward: reward ? { status: reward.status, transactionId: reward.transaction_id, hashscanUrl: reward.transaction_id ? transactionUrl(reward.transaction_id) : null } : null };
}
