import { readConfig } from './config.js';
import { Database } from './db.js';
import { HederaLedger } from './hedera.js';
import { S3Storage } from './storage.js';
import { Marketplace } from './service.js';
export function runtime(): Marketplace {
  const config = readConfig();
  return new Marketplace(new Database(config.DATABASE_URL), new HederaLedger(config), new S3Storage(config), config);
}
