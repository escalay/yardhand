/**
 * Packs: a curated kit for one kind of work. Its tools (from any upstreams, each with the pack's own wording, name
 * and fixed inputs when it has some), the playbooks and manuals that go with them. A key locked to a pack reaches
 * nothing else.
 * `based_on` is the tool version a pack's wording was written against: when the live version's description moves
 * on, the wording is flagged until the owner keeps or rewrites it.
 */
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const packs = sqliteTable('packs', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  title: text('title').notNull(),
  /** What the pack is for, as agents read it: it becomes the server instructions for its keys. */
  description: text('description').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const PACK_REASONS = ['picked', 'named', 'route', 'meaning'] as const
export type PackReason = (typeof PACK_REASONS)[number]

export const packTools = sqliteTable(
  'pack_tools',
  {
    packId: text('pack_id').notNull(),
    /** What the pack's keys call it: its alias, else the tool's own name. */
    name: text('name').notNull(),
    toolName: text('tool_name').notNull(),
    position: integer('position').notNull(),
    /** The pack's own description of the tool, or null to use the upstream's. */
    description: text('description'),
    basedOn: text('based_on'),
    /** Why it is in: picked by the owner, named in a playbook, by a playbook's route, or by meaning (confirmed). */
    reason: text('reason', { enum: PACK_REASONS }).notNull(),
    /** The playbook that brought it in, if one did. */
    via: text('via'),
    /** Inputs the pack fills on every call (JSON), hidden from its keys; null when none. */
    fixed: text('fixed'),
  },
  (table) => [primaryKey({ columns: [table.packId, table.name] })],
)

export const packItems = sqliteTable(
  'pack_items',
  {
    packId: text('pack_id').notNull(),
    kind: text('kind', { enum: ['playbook', 'manual'] }).notNull(),
    /** The name agents use: `cookbook-plan-a-dinner`, `cookbook`. */
    name: text('name').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [primaryKey({ columns: [table.packId, table.kind, table.name] })],
)

export const PACKS_MIGRATIONS = [
  `create table if not exists packs (id text primary key, name text not null unique, title text not null,
    description text not null, created_at text not null, updated_at text not null)`,
  `create table if not exists pack_tools (pack_id text not null, tool_name text not null, position integer not null,
    description text, based_on text, reason text not null, via text, primary key (pack_id, tool_name))`,
  `create table if not exists pack_items (pack_id text not null, kind text not null, name text not null,
    position integer not null, primary key (pack_id, kind, name))`,
  // A tool may sit in a pack more than once under its own names, so a pack tool is keyed by the name its keys call
  `create table pack_tools_next (pack_id text not null, name text not null, tool_name text not null,
    position integer not null, description text, based_on text, reason text not null, via text, fixed text,
    primary key (pack_id, name));
  insert into pack_tools_next (pack_id, name, tool_name, position, description, based_on, reason, via, fixed)
    select pack_id, tool_name, tool_name, position, description, based_on, reason, via, null from pack_tools;
  drop table pack_tools;
  alter table pack_tools_next rename to pack_tools`,
] as const

export type PackRow = typeof packs.$inferSelect
export type PackToolRow = typeof packTools.$inferSelect
export type PackItemRow = typeof packItems.$inferSelect
