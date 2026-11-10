/**
 * Tools the gateway serves, named `<upstream>.<tool>`, and their versions. Only a `live` version is ever served; a
 * changed description or schema from a `review` upstream waits as `pending` until the owner approves it.
 * `tools_fts` indexes the live versions for keyword search.
 */
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const tools = sqliteTable('tools', {
  name: text('name').primaryKey(),
  upstreamId: text('upstream_id').notNull(),
  remoteName: text('remote_name').notNull(),
  liveVersion: text('live_version'),
  /** The owner's say over the upstream's hints: `read` or `write`, or null to follow the annotations. */
  access: text('access', { enum: ['read', 'write', 'off'] }),
  /** The HTTP route behind the tool, when its upstream says: kept outside versions, it is never reviewed. */
  route: text('route'),
  removedAt: text('removed_at'),
  createdAt: text('created_at').notNull(),
})

export const toolVersions = sqliteTable('tool_versions', {
  id: text('id').primaryKey(),
  toolName: text('tool_name').notNull(),
  hash: text('hash').notNull(),
  state: text('state', { enum: ['live', 'pending', 'rejected', 'superseded'] }).notNull(),
  title: text('title'),
  description: text('description').notNull(),
  inputSchema: text('input_schema').notNull(),
  outputSchema: text('output_schema'),
  annotations: text('annotations').notNull(),
  createdAt: text('created_at').notNull(),
})

/**
 * A connection's tool groups, found by rules (route, name) or a model, or made by the owner. An `off` group switches
 * off every tool filed in it, now and later, unless the owner set a tool's own access.
 */
export const toolGroups = sqliteTable(
  'tool_groups',
  {
    upstreamId: text('upstream_id').notNull(),
    key: text('key').notNull(),
    title: text('title').notNull(),
    /** One line on what its tools are for, when a model wrote one. */
    purpose: text('purpose'),
    source: text('source', { enum: ['rules', 'ai', 'owner'] }).notNull(),
    off: integer('off', { mode: 'boolean' }).notNull(),
    position: integer('position').notNull(),
  },
  (table) => [primaryKey({ columns: [table.upstreamId, table.key] })],
)

/** Which group each tool is filed in; `moved` when the owner put it there, so a regroup leaves it be. */
export const toolGroupMembers = sqliteTable('tool_group_members', {
  toolName: text('tool_name').primaryKey(),
  upstreamId: text('upstream_id').notNull(),
  groupKey: text('group_key').notNull(),
  moved: integer('moved', { mode: 'boolean' }).notNull(),
})

/** A connection's switches by effect: every tool that reads, changes things or deletes, off at once. */
export const effectSwitches = sqliteTable(
  'effect_switches',
  {
    upstreamId: text('upstream_id').notNull(),
    effect: text('effect', { enum: ['reads', 'changes', 'deletes'] }).notNull(),
    off: integer('off', { mode: 'boolean' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.upstreamId, table.effect] })],
)

export const TOOLS_MIGRATIONS = [
  `create table if not exists tools (name text primary key, upstream_id text not null, remote_name text not null,
    live_version text, removed_at text, created_at text not null)`,
  'create index if not exists tools_upstream on tools (upstream_id)',
  `create table if not exists tool_versions (id text primary key, tool_name text not null, hash text not null,
    state text not null, title text, description text not null, input_schema text not null, output_schema text,
    annotations text not null, created_at text not null)`,
  'create index if not exists tool_versions_tool on tool_versions (tool_name, state)',
  "create virtual table if not exists tools_fts using fts5(name, upstream, title, description, tokenize = 'porter unicode61')",
  'alter table tools add column access text',
  'alter table tools add column route text',
  `create table if not exists tool_groups (upstream_id text not null, key text not null, title text not null,
    purpose text, source text not null, off integer not null, position integer not null, primary key (upstream_id, key));
  create table if not exists tool_group_members (tool_name text primary key, upstream_id text not null,
    group_key text not null, moved integer not null);
  create index if not exists tool_group_members_upstream on tool_group_members (upstream_id, group_key);
  create table if not exists effect_switches (upstream_id text not null, effect text not null, off integer not null,
    primary key (upstream_id, effect))`,
  // Creates and updates a server marks destructive now count as changes: where deletes were off, they stay off
  `update tools set access = 'off' where access is null and removed_at is null
    and upstream_id in (select upstream_id from effect_switches where effect = 'deletes' and off = 1)
    and upstream_id not in (select upstream_id from effect_switches where effect = 'changes' and off = 1)
    and (route is null or upper(route) not like 'DELETE %')
    and (lower(remote_name) like 'create%' or lower(remote_name) like 'add%' or lower(remote_name) like 'update%'
      or lower(remote_name) like 'upsert%' or lower(remote_name) like 'insert%' or lower(remote_name) like 'set%'
      or lower(remote_name) like 'save%' or lower(remote_name) like 'attach%')
    and live_version in (select id from tool_versions where json_extract(annotations, '$.destructiveHint') = 1)`,
] as const

export type ToolRow = typeof tools.$inferSelect
export type ToolGroupRow = typeof toolGroups.$inferSelect
export type Effect = (typeof effectSwitches.$inferSelect)['effect']
export type VersionRow = typeof toolVersions.$inferSelect
