import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { Database } from '../src/db.js';
const db = new Database(process.env.DATABASE_URL!);
try {
  await db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('fieldproof:migrations'))");
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) {
      if ((await tx.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) continue;
      await tx.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
      console.log(`Applied ${name}`);
    }
  });
} finally { await db.close(); }
