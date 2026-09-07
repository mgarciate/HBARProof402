import { runtime } from './runtime.js';
import { buildApp } from './app.js';
const service = runtime();
const app = await buildApp(service);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); service.ledger.close(); await service.db.close(); });
await app.listen({ host: service.config.HOST, port: service.config.PORT });
