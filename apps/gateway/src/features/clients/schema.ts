/**
 * Clients (who calls the gateway), the upstreams each may reach, pinned tools (`*` = the global default), and the packs
 * a pack key opens.
 */
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { APP_IDS } from './setup.js'

export const clients = sqliteTable('clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['key', 'oauth'] }).notNull(),
  keyHash: text('key_hash'),
  /** The name a client signed in before 0.6.4 gave, which its tokens from then are known by; null for every later one. */
  oauthName: text('oauth_name'),
  /** The app's OAuth client id, for display: a client is known by its grants (`client_grants`), never by this. */
  oauthClientId: text('oauth_client_id'),
  scope: text('scope', { enum: ['read', 'write'] }).notNull(),
  allUpstreams: integer('all_upstreams', { mode: 'boolean' }).notNull(),
  ownPins: integer('own_pins', { mode: 'boolean' }).notNull(),
  macTools: integer('mac_tools', { mode: 'boolean' }).notNull(),
  resultCap: integer('result_cap').notNull(),
  /** Its default pack (plain `/mcp` and REST serve it), or null for everything its allowlist reaches. */
  packId: text('pack_id'),
  /** After this the key stops working; null for never. */
  expiresAt: text('expires_at'),
  /** Where it runs, as the owner said when making it: a setup surface id; null when not said. */
  app: text('app', { enum: APP_IDS }),
  /** How an OAuth client locked to a pack came in: `owner` approved it at the pack's address; null for every other. */
  joinedBy: text('joined_by', { enum: ['owner', 'invite', 'request'] }),
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

/** The kit's grants each OAuth client row stands for; `legacy` marks one mapped by name from before 0.6.4. */
export const clientGrants = sqliteTable('client_grants', {
  grant: text('grant').primaryKey(),
  clientId: text('client_id').notNull(),
  legacy: integer('legacy', { mode: 'boolean' }).notNull(),
})

/** One row once the sign-ins from before 0.6.4 are mapped: plain, so any master key reads it. */
export const clientLegacyMapping = sqliteTable('client_legacy_mapping', {
  at: text('at').notNull(),
  signIns: integer('sign_ins').notNull(),
})

/**
 * Every pack a key opens, each at `/p/<pack>/`; `clients.pack_id` names the default among them. The one row per
 * client and pack: what belongs to a person in a pack goes here.
 */
export const clientPacks = sqliteTable(
  'client_packs',
  {
    clientId: text('client_id').notNull(),
    packId: text('pack_id').notNull(),
    position: integer('position').notNull(),
    /** The former name of the pack this client last came by, and when; null once it comes by the name now. */
    cameBy: text('came_by'),
    cameByAt: text('came_by_at'),
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
  'alter table clients add column app text',
  'alter table client_packs add column came_by text',
  'alter table client_packs add column came_by_at text',
  `create table if not exists client_grants (grant text primary key, client_id text not null,
    legacy integer not null default 0);
  create index if not exists client_grants_client on client_grants (client_id);
  alter table clients add column oauth_client_id text`,
  'create table if not exists client_legacy_mapping (at text not null, sign_ins integer not null)',
  'alter table clients add column joined_by text',
] as const

export type ClientRow = typeof clients.$inferSelect
export type ClientPackRow = typeof clientPacks.$inferSelect
export const GLOBAL_PINS = '*'
export const DEFAULT_RESULT_CAP = 25_000
