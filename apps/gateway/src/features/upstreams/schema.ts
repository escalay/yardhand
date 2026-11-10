/** Upstreams: the servers the gateway reaches. Their credentials live sealed in the vault as `upstream:<id>`. */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const upstreams = sqliteTable('upstreams', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  kind: text('kind', { enum: ['mcp', 'http', 'composio', 'sample'] }).notNull(),
  url: text('url').notNull(),
  auth: text('auth', { enum: ['none', 'bearer', 'header', 'basic', 'oauth'] }).notNull(),
  authHeader: text('auth_header'),
  /** Kind-specific, non-secret settings (JSON): for `http`, the spec and which operations to expose. */
  config: text('config'),
  trust: text('trust', { enum: ['trusted', 'review'] }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  instructions: text('instructions'),
  server: text('server'),
  status: text('status', { enum: ['new', 'live', 'failing'] }).notNull(),
  lastError: text('last_error'),
  toolCount: integer('tool_count').notNull(),
  /** The owner's switch: its playbooks are offered to agents (listed, searched and fetched). */
  playbooks: integer('playbooks', { mode: 'boolean' }).notNull().default(true),
  /**
   * The owner's switch: links to its own host open through the gateway with its credential (`/u/{id}/r/*`). Off for an
   * upstream whose host holds more than it should hand out (an account-wide API), so its key never fetches for a link.
   */
  linkProxy: integer('link_proxy', { mode: 'boolean' }).notNull().default(true),
  syncedAt: text('synced_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const UPSTREAMS_MIGRATIONS = [
  `create table if not exists upstreams (id text primary key, title text not null, kind text not null, url text not null,
    auth text not null, auth_header text, trust text not null, enabled integer not null, instructions text, server text,
    status text not null, last_error text, tool_count integer not null, synced_at text, created_at text not null,
    updated_at text not null)`,
  'alter table upstreams add column config text',
  'alter table upstreams add column playbooks integer not null default 1',
  'alter table upstreams add column link_proxy integer not null default 1',
] as const

export type UpstreamRow = typeof upstreams.$inferSelect
export const secretIdOf = (upstreamId: string) => `upstream:${upstreamId}`
