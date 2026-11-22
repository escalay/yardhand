/** Builds: the only queries on them. A build is only ever read by its pack's id and its own. */
import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import type { Db } from '../../kit/index.js'
import { seal, unseal } from '../vault/crypto.js'
import { type BuildRow, type BuildStatus, packBuilds } from './schema.js'
import type { Spent } from './spend.js'

export type BuildEstimate = { usd: number | null; tokens: number; modelCalls: { likely: number; max: number } }
const NOTHING_SPENT: Spent = { usd: 0, tokens: 0, modelCalls: 0, known: false }

/** A build as read back, its JSON parsed and its proposal unsealed. */
const readOf = <Proposal>(key: Buffer, row: BuildRow) => ({
  ...row,
  tasks: JSON.parse(row.tasks) as string[],
  estimate: JSON.parse(row.estimate) as BuildEstimate,
  spent: JSON.parse(row.spent) as Spent,
  notDone: row.notDone ? (JSON.parse(row.notDone) as string[]) : [],
  proposal: row.proposal ? (JSON.parse(unseal(key, row.proposal)) as Proposal) : null,
})

export const buildsRepo = <Proposal>(db: Db, key: Buffer) => ({
  create: async (draft: {
    id?: string
    packId: string
    mode: 'build' | 'refresh'
    tasks: string[]
    estimate: BuildEstimate
    packUpdatedAt: string
  }) => {
    const id = draft.id ?? `pb_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    await db.insert(packBuilds).values({
      id,
      packId: draft.packId,
      mode: draft.mode,
      status: 'running',
      tasks: JSON.stringify(draft.tasks),
      estimate: JSON.stringify(draft.estimate),
      spent: JSON.stringify(NOTHING_SPENT),
      packUpdatedAt: draft.packUpdatedAt,
      createdAt: new Date().toISOString(),
    })
    return id
  },
  get: async (packId: string, id: string) => {
    const [row] = await db
      .select()
      .from(packBuilds)
      .where(and(eq(packBuilds.packId, packId), eq(packBuilds.id, id)))
    return row ? readOf<Proposal>(key, row) : undefined
  },
  /** A pack's newest builds, newest first. */
  newestOf: async (packId: string, limit = 5) =>
    (
      await db
        .select()
        .from(packBuilds)
        .where(eq(packBuilds.packId, packId))
        .orderBy(desc(packBuilds.createdAt))
        .limit(limit)
    ).map((row) => ({ id: row.id, status: row.status })),
  /** Ends a running build, its proposal sealed. */
  finish: (
    id: string,
    end: {
      status: 'ready' | 'stopped' | 'failed'
      proposal: Proposal | null
      spent: Spent
      stopped?: 'cap' | 'provider' | null
      notDone?: string[]
      error?: string | null
    },
  ) =>
    db
      .update(packBuilds)
      .set({
        status: end.status,
        proposal: end.proposal ? seal(key, JSON.stringify(end.proposal)) : null,
        spent: JSON.stringify(end.spent),
        stopped: end.stopped ?? null,
        notDone: end.notDone?.length ? JSON.stringify(end.notDone) : null,
        error: end.error ?? null,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(packBuilds.id, id)),
  /** Moves a build on only from one of these statuses: false when another request moved it first. */
  settle: async (packId: string, id: string, from: BuildStatus[], to: 'accepted' | 'discarded') =>
    (
      await db
        .update(packBuilds)
        .set({ status: to })
        .where(and(eq(packBuilds.packId, packId), eq(packBuilds.id, id), inArray(packBuilds.status, from)))
        .returning({ id: packBuilds.id })
    ).length > 0,
  forgetPack: (packId: string) => db.delete(packBuilds).where(eq(packBuilds.packId, packId)),
  /** Drops builds started before `before`. */
  prune: (before: string) => db.delete(packBuilds).where(lt(packBuilds.createdAt, before)),
})

export type BuildsRepo<Proposal = unknown> = ReturnType<typeof buildsRepo<Proposal>>
