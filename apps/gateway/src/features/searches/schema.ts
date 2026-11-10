/** Every tool search a client made: what it asked and how many tools came back. The owner's demand signal. */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const searches = sqliteTable('searches', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull(),
  clientName: text('client_name').notNull(),
  query: text('query').notNull(),
  /** Lower case, single spaces: searches that differ only in case or spacing count as one. */
  normalized: text('normalized').notNull(),
  results: integer('results').notNull(),
  /** The names it returned, best first (JSON, at most 20): a search is answered when one of them is called. */
  tools: text('tools').notNull(),
  via: text('via').notNull(),
  createdAt: text('created_at').notNull(),
})

export const SEARCHES_MIGRATIONS = [
  `create table if not exists searches (id text primary key, client_id text not null, client_name text not null,
    query text not null, normalized text not null, results integer not null, tools text not null, via text not null,
    created_at text not null)`,
  'create index if not exists searches_created on searches (created_at)',
] as const

export type SearchRow = typeof searches.$inferSelect
