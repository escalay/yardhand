/**
 * The call log: one row per call through the pipeline, whichever door it came in by: running a tool, reading a manual,
 * fetching a playbook or following a link (`kind`).
 */
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const calls = sqliteTable('calls', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull(),
  clientName: text('client_name').notNull(),
  /** The tool's name, or the manual's, the playbook's, or the link followed. */
  tool: text('tool').notNull(),
  kind: text('kind', { enum: ['tool', 'manual', 'playbook', 'link'] })
    .notNull()
    .default('tool'),
  upstreamId: text('upstream_id'),
  versionId: text('version_id'),
  via: text('via', { enum: ['rest', 'mcp', 'passthrough', 'app'] }).notNull(),
  /** `asked`: the upstream asked the caller something mid-call; the answers come as the next call. */
  status: text('status', { enum: ['ok', 'tool_error', 'refused', 'failed', 'asked'] }).notNull(),
  error: text('error'),
  durationMs: integer('duration_ms').notNull(),
  resultBytes: integer('result_bytes').notNull(),
  /** The caller's W3C trace id when it sent one: the call is a span in that trace. Null: a trace of its own. */
  traceId: text('trace_id'),
  createdAt: text('created_at').notNull(),
})

/** Results too big for an MCP client's cap, sealed and kept an hour so the client can page through them. */
export const heldResults = sqliteTable('held_results', {
  callId: text('call_id').primaryKey(),
  sealed: text('sealed').notNull(),
  pageChars: integer('page_chars').notNull(),
  pages: integer('pages').notNull(),
  expiresAt: text('expires_at').notNull(),
})

/** What each call sent and got back, sealed and kept 30 days, for the owner to debug with; never sent anywhere. */
export const callPayloads = sqliteTable('call_payloads', {
  callId: text('call_id').primaryKey(),
  sealed: text('sealed').notNull(),
  expiresAt: text('expires_at').notNull(),
})

/**
 * The links a pack key was handed in its tools' results (sha256 of each), kept a day: a pack key opens these through
 * the link proxy and `read_resource`, and nothing else on the upstream.
 */
export const handedLinks = sqliteTable(
  'handed_links',
  { clientId: text('client_id').notNull(), hash: text('hash').notNull(), expiresAt: text('expires_at').notNull() },
  (table) => [primaryKey({ columns: [table.clientId, table.hash] })],
)

export const CALLS_MIGRATIONS = [
  `create table if not exists calls (id text primary key, client_id text not null, client_name text not null,
    tool text not null, upstream_id text, version_id text, via text not null, status text not null, error text,
    duration_ms integer not null, result_bytes integer not null, created_at text not null)`,
  'create index if not exists calls_client on calls (client_id, created_at)',
  'create index if not exists calls_created on calls (created_at)',
  `create table if not exists held_results (call_id text primary key, sealed text not null, page_chars integer not null,
    pages integer not null, expires_at text not null)`,
  'create table if not exists call_payloads (call_id text primary key, sealed text not null, expires_at text not null)',
  'create index if not exists calls_upstream on calls (upstream_id, created_at)',
  "alter table calls add column kind text not null default 'tool'",
  'alter table calls add column trace_id text',
  `create table if not exists handed_links (client_id text not null, hash text not null, expires_at text not null,
    primary key (client_id, hash))`,
] as const

export type CallRow = typeof calls.$inferSelect
