import { setTimeout } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { request } from './http.js';
import { sha256 } from '../src/domain.js';
import { buyVerification } from './buy-verification.js';

const [overviewPath, detailPath] = process.argv.slice(2);
if (!overviewPath || !detailPath || !process.env.DEMO_PAYOUT_ACCOUNT_ID) throw new Error('Usage: npm run demo -- overview.jpg detail.jpg; set DEMO_PAYOUT_ACCOUNT_ID. This sends a real HBAR testnet reward.');
const agent = process.env.AGENT_API_TOKEN!, worker = process.env.WORKER_API_TOKEN!;
const me = await request('/v1/me', worker);
await request(`/v1/workers/${me.id}/payout-account`, worker, 'PUT', { hederaAccountId: process.env.DEMO_PAYOUT_ACCOUNT_ID });
const qrHash = sha256('FIELDPROOF:bike_demo_01');
const task = await request('/v1/tasks', agent, 'POST', {
  assetExternalId: 'bike_demo_01', expectedQrHash: qrHash, title: 'Verify bicycle condition',
  instructions: ['Scan FIELDPROOF:bike_demo_01', 'Capture full side and rear derailleur'], requiredEvidence: ['asset_overview', 'component_detail'],
  reward: { asset: 'HBAR', amount: '0.1' }, verificationPriceLimit: { asset: 'HBAR', amount: '0.01' },
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), policyVersion: 'bike-visual-v1',
});
console.log(`Task ${task.id}; verifier=mock; checking configured payment mode`);
async function until(predicate: (task: any) => boolean): Promise<any> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const current = await request(`/v1/tasks/${task.id}`, agent);
    if (predicate(current)) return current;
    await setTimeout(3000);
  }
  throw new Error(`Timed out. Inspect /v1/tasks/${task.id} and operator jobs; do not recreate the task to retry a reward.`);
}
await until(t => t.status === 'OPEN');
await request(`/v1/tasks/${task.id}/claim`, worker, 'POST', {});
const bytes = await Promise.all([overviewPath, detailPath].map(async path => sharp(await readFile(path)).rotate().jpeg().toBuffer()));
const types = ['asset_overview', 'component_detail'];
const files = bytes.map((buffer, i) => ({ type: types[i], sha256: sha256(buffer), size: buffer.length, contentType: 'image/jpeg' }));
const uploads = await request(`/v1/tasks/${task.id}/evidence/uploads`, worker, 'POST', { files });
for (let i = 0; i < uploads.files.length; i++) {
  const upload = uploads.files[i]; const response = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: new Uint8Array(bytes[i]!) });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
}
await request(`/v1/tasks/${task.id}/evidence`, worker, 'POST', { qrHash, consent: true, answers: { visibleDamage: false }, files: uploads.files.map((upload: any, i: number) => ({ type: upload.type, uploadId: upload.uploadId, sha256: files[i]!.sha256 })) });
const submitted = await request(`/v1/tasks/${task.id}`, agent);
if (submitted.verificationPaymentMode === 'x402') {
  await until(t => t.hcs.some((event: any) => event.type === 'EvidenceSubmitted' && event.status === 'CONFIRMED'));
  console.log(JSON.stringify(await buyVerification(task.id), null, 2));
} else console.log('Legacy free mock task: x402=not_performed');
const result = await until(t => ['PAID', 'REJECTED', 'MANUAL_REVIEW'].includes(t.status));
console.log(`Task status: ${result.status}`);
console.log(JSON.stringify(await request(`/v1/tasks/${task.id}/receipt/verify`, agent), null, 2));
