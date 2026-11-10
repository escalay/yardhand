/** Browser sessions for the owner where no Cloudflare Access stands in front (the single compose deploy, local dev). */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const sessions = sqliteTable('sessions', {
  /** sha256 of the cookie's token; the token itself is never stored. */
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  userAgent: text('user_agent'),
})

export const SESSIONS_MIGRATIONS = [
  'create table if not exists sessions (id text primary key, created_at text not null, expires_at text not null, user_agent text)',
] as const
