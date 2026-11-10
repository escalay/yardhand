/**
 * What an upstream offers besides tools: manuals (its skills, every file), playbooks (its prompts), and the links it
 * serves (resource templates and listed resources). Versioned like tools: only a `live` version is served, and a
 * change from a `review` upstream waits as `pending`. `catalog_fts` indexes live manuals and playbooks for search.
 */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const CATALOG_KINDS = ['manual', 'playbook', 'template', 'resource'] as const
export type CatalogKind = (typeof CATALOG_KINDS)[number]

export const catalogItems = sqliteTable('catalog_items', {
  /** `<kind>:<upstream>:<remote name>`. */
  id: text('id').primaryKey(),
  upstreamId: text('upstream_id').notNull(),
  kind: text('kind', { enum: CATALOG_KINDS }).notNull(),
  /** As the upstream names it: the skill's name, the prompt's name, the template or the URI. */
  remoteName: text('remote_name').notNull(),
  /** As agents see it: `cookbook` for a manual, `cookbook-plan-a-dinner` for a playbook. */
  name: text('name').notNull(),
  liveVersion: text('live_version'),
  removedAt: text('removed_at'),
  createdAt: text('created_at').notNull(),
})

export const catalogVersions = sqliteTable('catalog_versions', {
  id: text('id').primaryKey(),
  itemId: text('item_id').notNull(),
  hash: text('hash').notNull(),
  state: text('state', { enum: ['live', 'pending', 'rejected', 'superseded'] }).notNull(),
  /** The kind's content as JSON (`CatalogContent`). */
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
})

export const CATALOG_MIGRATIONS = [
  `create table if not exists catalog_items (id text primary key, upstream_id text not null, kind text not null,
    remote_name text not null, name text not null, live_version text, removed_at text, created_at text not null)`,
  'create index if not exists catalog_items_upstream on catalog_items (upstream_id, kind)',
  'create index if not exists catalog_items_name on catalog_items (kind, name)',
  `create table if not exists catalog_versions (id text primary key, item_id text not null, hash text not null,
    state text not null, content text not null, created_at text not null)`,
  'create index if not exists catalog_versions_item on catalog_versions (item_id, state)',
  "create virtual table if not exists catalog_fts using fts5(id unindexed, kind unindexed, name, upstream, title, description, tokenize = 'porter unicode61')",
] as const

export type CatalogItemRow = typeof catalogItems.$inferSelect
export type CatalogVersionRow = typeof catalogVersions.$inferSelect
