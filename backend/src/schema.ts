import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const principals = pgTable('principals', {
  id: uuid('id').primaryKey(),
  role: text('role').$type<'agent' | 'worker' | 'operator'>().notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workers = pgTable('workers', {
  id: uuid('id').primaryKey().references(() => principals.id),
  payoutAccountId: text('payout_account_id'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
});
