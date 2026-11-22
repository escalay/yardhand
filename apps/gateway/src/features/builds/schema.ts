/**
 * Builds: one row per Build or Refresh with AI of a pack, with what it was asked, what it spent and its one proposal,
 * sealed with the master key as call payloads are. Kept 30 days; a pack's go with it.
 */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const BUILD_STATUSES = ['running', 'ready', 'stopped', 'failed', 'accepted', 'discarded'] as const
export type BuildStatus = (typeof BUILD_STATUSES)[number]

export const packBuilds = sqliteTable('pack_builds', {
  id: text('id').primaryKey(),
  packId: text('pack_id').notNull(),
  /** `build` drafts the pack; `refresh` sends it as it is and asks for changes. */
  mode: text('mode', { enum: ['build', 'refresh'] }).notNull(),
  status: text('status', { enum: BUILD_STATUSES }).notNull(),
  /** The example tasks (JSON). */
  tasks: text('tasks').notNull(),
  /** The proposal, sealed; null until the build ends with one. */
  proposal: text('proposal'),
  /** What it was estimated at when it started (JSON). */
  estimate: text('estimate').notNull(),
  /** What it spent on the model (JSON). */
  spent: text('spent').notNull(),
  /** Why it stopped early: the $1 cap, or the provider refusing for money. */
  stopped: text('stopped', { enum: ['cap', 'provider'] }),
  /** What a stopped build didn't get to (JSON). */
  notDone: text('not_done'),
  error: text('error'),
  /** The pack's `updated_at` when the build started: a proposal is accepted only onto that pack. */
  packUpdatedAt: text('pack_updated_at').notNull(),
  createdAt: text('created_at').notNull(),
  finishedAt: text('finished_at'),
})

export const BUILDS_MIGRATIONS = [
  `create table if not exists pack_builds (id text primary key, pack_id text not null, mode text not null,
    status text not null, tasks text not null, proposal text, estimate text not null, spent text not null,
    stopped text, not_done text, error text, pack_updated_at text not null, created_at text not null,
    finished_at text)`,
  'create index if not exists pack_builds_pack on pack_builds (pack_id, created_at)',
] as const

export type BuildRow = typeof packBuilds.$inferSelect
