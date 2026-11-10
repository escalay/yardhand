/** Upstreams in the database: the only queries on this table. */
import { asc, eq } from 'drizzle-orm'
import type { Db } from '../../kit/index.js'
import { type UpstreamRow, upstreams } from './schema.js'

export type UpstreamDraft = Pick<
  UpstreamRow,
  'id' | 'title' | 'kind' | 'url' | 'auth' | 'authHeader' | 'trust' | 'enabled' | 'config'
> & { playbooks?: boolean; linkProxy?: boolean }
export type UpstreamChange = Partial<Omit<UpstreamDraft, 'id'>>

export const upstreamsRepo = (db: Db) => {
  const now = () => new Date().toISOString()
  return {
    list: () => db.select().from(upstreams).orderBy(asc(upstreams.id)),
    get: async (id: string) => (await db.select().from(upstreams).where(eq(upstreams.id, id)))[0],
    create: (draft: UpstreamDraft) =>
      db.insert(upstreams).values({ ...draft, status: 'new', toolCount: 0, createdAt: now(), updatedAt: now() }),
    update: (id: string, change: UpstreamChange) =>
      db
        .update(upstreams)
        .set({ ...change, updatedAt: now() })
        .where(eq(upstreams.id, id)),
    markSynced: (id: string, result: { instructions: string | null; server: string | null; toolCount: number }) =>
      db
        .update(upstreams)
        .set({ ...result, status: 'live', lastError: null, syncedAt: now(), updatedAt: now() })
        .where(eq(upstreams.id, id)),
    markFailing: (id: string, error: string) =>
      db
        .update(upstreams)
        .set({ status: 'failing', lastError: error.slice(0, 1000), updatedAt: now() })
        .where(eq(upstreams.id, id)),
    remove: (id: string) => db.delete(upstreams).where(eq(upstreams.id, id)),
  }
}

export type UpstreamsRepo = ReturnType<typeof upstreamsRepo>
