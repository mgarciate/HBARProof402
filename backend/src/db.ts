import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient, QueryResultRow } from 'pg';
import * as schema from './schema.js';

export type Tx = PoolClient;
export class Database {
  readonly pool: pg.Pool;
  readonly orm;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 10_000, statement_timeout: 60_000, query_timeout: 65_000 });
    this.pool.on('error', () => { console.error('{"code":"DATABASE_IDLE_CONNECTION_ERROR"}'); });
    this.orm = drizzle(this.pool, { schema });
  }
  async query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> { return (await this.pool.query<T>(sql, params)).rows; }
  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    try { await tx.query('BEGIN'); const result = await fn(tx); await tx.query('COMMIT'); return result; }
    catch (e) { await tx.query('ROLLBACK'); throw e; } finally { tx.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
export async function enqueue(tx: Tx, kind: string, taskId: string, key: string, payload: unknown = {}): Promise<void> {
  await tx.query('INSERT INTO jobs(kind, task_id, dedupe_key, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (dedupe_key) DO NOTHING', [kind, taskId, key, JSON.stringify(payload)]);
}
