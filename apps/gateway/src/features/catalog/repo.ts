/** Catalog items, their versions and the search index over live manuals and playbooks: the only queries on them. */
import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import type { Db } from '../../kit/index.js'
import { ftsQuery } from '../tools/words.js'
import { type CatalogContent, hashContent, textOf } from './content.js'
import {
  type CatalogItemRow,
  type CatalogKind,
  type CatalogVersionRow,
  catalogItems,
  catalogVersions,
} from './schema.js'

/** An item as served: its row and its live content. */
export type LiveItem = {
  id: string
  upstreamId: string
  kind: CatalogKind
  name: string
  remoteName: string
  versionId: string
  content: CatalogContent
}

const liveOf = (item: CatalogItemRow, version: CatalogVersionRow): LiveItem => ({
  id: item.id,
  upstreamId: item.upstreamId,
  kind: item.kind,
  name: item.name,
  remoteName: item.remoteName,
  versionId: version.id,
  content: JSON.parse(version.content) as CatalogContent,
})

const SEARCHED: CatalogKind[] = ['manual', 'playbook']

export const catalogRepo = (db: Db) => {
  const liveJoin = (where?: SQL) =>
    db
      .select({ item: catalogItems, version: catalogVersions })
      .from(catalogItems)
      .innerJoin(catalogVersions, eq(catalogVersions.id, catalogItems.liveVersion))
      .where(where ? and(isNull(catalogItems.removedAt), where) : isNull(catalogItems.removedAt))

  const reindex = async (itemId: string) => {
    await db.run(sql`delete from catalog_fts where id = ${itemId}`)
    const row = (await liveJoin(eq(catalogItems.id, itemId)))[0]
    if (!row || !SEARCHED.includes(row.item.kind)) return
    const text = textOf(JSON.parse(row.version.content) as CatalogContent)
    await db.run(
      sql`insert into catalog_fts (id, kind, name, upstream, title, description) values (${itemId}, ${row.item.kind}, ${row.item.name}, ${row.item.upstreamId}, ${text.title ?? ''}, ${text.description})`,
    )
  }

  const makeLive = async (itemId: string, versionId: string) => {
    await db
      .update(catalogVersions)
      .set({ state: 'superseded' })
      .where(and(eq(catalogVersions.itemId, itemId), eq(catalogVersions.state, 'live')))
    await db.update(catalogVersions).set({ state: 'live' }).where(eq(catalogVersions.id, versionId))
    await db.update(catalogItems).set({ liveVersion: versionId, removedAt: null }).where(eq(catalogItems.id, itemId))
    await reindex(itemId)
  }

  return {
    /** Which upstream each named item is from, without its content. */
    liveNames: async (names: string[]) =>
      names.length
        ? db
            .select({ name: catalogItems.name, kind: catalogItems.kind, upstreamId: catalogItems.upstreamId })
            .from(catalogItems)
            .where(and(isNull(catalogItems.removedAt), inArray(catalogItems.name, names)))
        : [],
    live: async (kind: CatalogKind, name: string) => {
      const row = (await liveJoin(and(eq(catalogItems.kind, kind), eq(catalogItems.name, name))))[0]
      return row ? liveOf(row.item, row.version) : undefined
    },
    /** Live items of these kinds from these upstreams, by name. */
    listLive: async ({ kinds, upstreams }: { kinds: CatalogKind[]; upstreams: 'all' | string[] }) => {
      if (upstreams !== 'all' && !upstreams.length) return []
      const rows = await liveJoin(
        and(
          inArray(catalogItems.kind, kinds),
          upstreams === 'all' ? undefined : inArray(catalogItems.upstreamId, upstreams),
        ),
      ).orderBy(asc(catalogItems.name))
      return rows.map((row) => liveOf(row.item, row.version))
    },
    /** Keyword search over live manuals and playbooks: item ids ranked by BM25, best first. */
    searchIds: async (q: string, limit: number) => {
      const match = ftsQuery(q)
      if (!match) return []
      const rows = await db.all<unknown>(
        sql`select id, bm25(catalog_fts, 0, 0, 4.0, 2.0, 3.0, 1.0) as score from catalog_fts where catalog_fts match ${match} order by score limit ${limit}`,
      )
      return rows.map((row) => (Array.isArray(row) ? String(row[0]) : String((row as { id: string }).id)))
    },
    liveByIds: async (ids: string[]) => {
      if (!ids.length) return []
      const rows = await liveJoin(inArray(catalogItems.id, ids))
      const byId = new Map(rows.map((row) => [row.item.id, liveOf(row.item, row.version)]))
      return ids.flatMap((id) => byId.get(id) ?? [])
    },
    /** Live items per upstream and kind, for the upstream cards. */
    counts: () =>
      db
        .select({ upstreamId: catalogItems.upstreamId, kind: catalogItems.kind, count: count() })
        .from(catalogItems)
        .where(and(isNull(catalogItems.removedAt), sql`${catalogItems.liveVersion} is not null`))
        .groupBy(catalogItems.upstreamId, catalogItems.kind),
    ofUpstream: (upstreamId: string) => db.select().from(catalogItems).where(eq(catalogItems.upstreamId, upstreamId)),
    item: async (id: string) => (await db.select().from(catalogItems).where(eq(catalogItems.id, id)))[0],
    versionsOf: (itemId: string) =>
      db
        .select()
        .from(catalogVersions)
        .where(eq(catalogVersions.itemId, itemId))
        .orderBy(asc(catalogVersions.createdAt)),
    version: async (id: string) => (await db.select().from(catalogVersions).where(eq(catalogVersions.id, id)))[0],
    pending: () =>
      db
        .select({ item: catalogItems, version: catalogVersions })
        .from(catalogVersions)
        .innerJoin(catalogItems, eq(catalogItems.id, catalogVersions.itemId))
        .where(eq(catalogVersions.state, 'pending'))
        .orderBy(asc(catalogVersions.createdAt)),
    create: async (row: Pick<CatalogItemRow, 'id' | 'upstreamId' | 'kind' | 'remoteName' | 'name'>) => {
      await db.insert(catalogItems).values({ ...row, createdAt: new Date().toISOString() })
    },
    addVersion: async (itemId: string, content: CatalogContent, state: CatalogVersionRow['state']) => {
      const id = `cv_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      await db.insert(catalogVersions).values({
        id,
        itemId,
        hash: hashContent(content),
        state,
        content: JSON.stringify(content),
        createdAt: new Date().toISOString(),
      })
      return id
    },
    makeLive,
    setState: (versionId: string, state: CatalogVersionRow['state']) =>
      db.update(catalogVersions).set({ state }).where(eq(catalogVersions.id, versionId)),
    markRemoved: async (itemId: string) => {
      await db.update(catalogItems).set({ removedAt: new Date().toISOString() }).where(eq(catalogItems.id, itemId))
      await reindex(itemId)
    },
    restore: async (itemId: string) => {
      await db.update(catalogItems).set({ removedAt: null }).where(eq(catalogItems.id, itemId))
      await reindex(itemId)
    },
    removeUpstream: async (upstreamId: string) => {
      const ids = (await db.select().from(catalogItems).where(eq(catalogItems.upstreamId, upstreamId))).map(
        (row) => row.id,
      )
      if (!ids.length) return
      await db.delete(catalogVersions).where(inArray(catalogVersions.itemId, ids))
      await db.delete(catalogItems).where(inArray(catalogItems.id, ids))
      for (const id of ids) await db.run(sql`delete from catalog_fts where id = ${id}`)
    },
  }
}

export type CatalogRepo = ReturnType<typeof catalogRepo>
