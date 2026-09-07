import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/db.js';
import { sha256 } from '../src/domain.js';
const db = new Database(process.env.DATABASE_URL!);
try {
  const entries = [['agent', process.env.AGENT_API_TOKEN], ['worker', process.env.WORKER_API_TOKEN], ['operator', process.env.OPERATOR_API_TOKEN]] as const;
  if (entries.some(([, token]) => !token || token.length < 32) || new Set(entries.map(([,token]) => token)).size !== entries.length) throw new Error('Set three distinct API tokens with at least 32 characters');
  await db.transaction(async tx => {
    for (const [role, token] of entries) {
      const row = (await tx.query('INSERT INTO principals(id,role,token_hash) VALUES ($1,$2,$3) ON CONFLICT (token_hash) DO UPDATE SET token_hash=EXCLUDED.token_hash RETURNING id,role', [randomUUID(), role, sha256(token!)])).rows[0];
      if (row.role !== role) throw new Error('Existing token belongs to another role');
      if (role === 'worker') await tx.query('INSERT INTO workers(id) VALUES ($1) ON CONFLICT DO NOTHING', [row.id]);
      console.log(`${role}: ${row.id}`);
    }
  });
} finally { await db.close(); }
