import { setTimeout } from 'node:timers/promises';
import { runtime } from './runtime.js';
import { Processor } from './processor.js';
import { MockVerifierAdapter } from './verifier.js';
const service = runtime(), processor = new Processor(service, new MockVerifierAdapter());
let running = true, lastMaintenance = 0;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { running = false; });
try {
  while (running) {
    try {
      if (Date.now() - lastMaintenance > 30_000) { await processor.maintain(); lastMaintenance = Date.now(); }
      if (!await processor.tick()) await setTimeout(1000);
    } catch { console.error(JSON.stringify({ code: 'WORKER_RETRY', timestamp: new Date().toISOString() })); await setTimeout(5000); }
  }
} finally { service.ledger.close(); await service.db.close(); }
