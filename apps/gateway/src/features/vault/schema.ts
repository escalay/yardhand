/** Sealed secrets: upstream credentials and OAuth tokens, AES-256-GCM under the master key. */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const secrets = sqliteTable('secrets', {
  id: text('id').primaryKey(),
  sealed: text('sealed').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const VAULT_MIGRATIONS = [
  'create table if not exists secrets (id text primary key, sealed text not null, updated_at text not null)',
] as const
