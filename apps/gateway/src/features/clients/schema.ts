/**
 * Clients (who calls the gateway), the upstreams each may reach, pinned tools (`*` = the global default), and the packs
 * a pack key opens.
 */
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const clients = sqliteTable('clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['key', 'oauth'] }).notNull(),
  keyHash: text('key_hash'),
  oauthName: text('oauth_name'),
  scope: text('scope', { enum: ['read', 'write'] }).notNull(),
  allUpstreams: integer('all_upstreams', { mode: 'boolean' }).notNull(),
  ownPins: integer('own_pins', { mode: 'boolean' }).notNull(),
  macTools: integer('mac_tools', { mode: 'boolean' }).notNull(),
  resultCap: integer('result_cap').notNull(),
  /** Its default pack (plain `/mcp` and REST serve it), or null for everything its allowlist reaches. */
  packId: text('pack_id'),
  /** After this the key stops working; null for never. */
  expiresAt: text('expires_at'),
  createdAt: text('created_at').notNull(),
  revokedAt: text('revoked_at'),
})

export const clientUpstreams = sqliteTable(
  'client_upstreams',
  { clientId: text('client_id').notNull(), upstreamId: text('upstream_id').notNull() },
  (table) => [primaryKey({ columns: [table.clientId, table.upstreamId] })],
)

export const pins = sqliteTable(
  'pins',
  {
    clientId: text('client_id').notNull(),
    toolName: text('tool_name').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.toolName] })],
)

/** Every pack a key opens, each at `/mcp/p/<pack>`; `clients.pack_id` names the default among them. */
export const clientPacks = sqliteTable(
  'client_packs',
  {
    clientId: text('client_id').notNull(),
    packId: text('pack_id').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.packId] })],
)

export const CLIENTS_MIGRATIONS = [
  `create table if not exists clients (id text primary key, name text not null, kind text not null, key_hash text unique,
    oauth_name text unique, scope text not null, all_upstreams integer not null, own_pins integer not null,
    mac_tools integer not null, result_cap integer not null, created_at text not null, revoked_at text)`,
  'create table if not exists client_upstreams (client_id text not null, upstream_id text not null, primary key (client_id, upstream_id))',
  'create table if not exists pins (client_id text not null, tool_name text not null, position integer not null, primary key (client_id, tool_name))',
  'alter table clients add column pack_id text',
  'alter table clients add column expires_at text',
  `create table if not exists client_packs (client_id text not null, pack_id text not null, position integer not null,
    primary key (client_id, pack_id));
  insert into client_packs (client_id, pack_id, position) select id, pack_id, 0 from clients where pack_id is not null`,
] as const

export type ClientRow = typeof clients.$inferSelect
export const GLOBAL_PINS = '*'
export const DEFAULT_RESULT_CAP = 25_000
