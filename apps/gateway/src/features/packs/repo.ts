/** Packs, their tools and their playbooks and manuals: the only queries on these tables. */
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm'
import type { Db } from '../../kit/index.js'
import type { Fixed } from './entries.js'
import {
  type PackItemRow,
  type PackReason,
  type PackRow,
  type PackToolRow,
  packItems,
  packNames,
  packs,
  packTools,
} from './schema.js'

export type PackDraft = { name: string; title: string; description: string }
/** A tool to add: `name` is the tool (`<upstream>.<tool>`); `alias` is what the pack's keys call it instead. */
export type PackToolDraft = {
  name: string
  reason: PackReason
  via?: string | null
  alias?: string | null
  fixed?: Fixed | null
}

const fixedText = (fixed: Fixed | null | undefined) =>
  fixed && Object.keys(fixed).length ? JSON.stringify(fixed) : null

/** A pack with everything in it, in order. */
export type PackContents = {
  pack: PackRow
  tools: PackToolRow[]
  playbooks: string[]
  manuals: string[]
}

export const packsRepo = (db: Db) => {
  const contentsOf = async (pack: PackRow): Promise<PackContents> => {
    const [toolRows, itemRows] = await Promise.all([
      db.select().from(packTools).where(eq(packTools.packId, pack.id)).orderBy(asc(packTools.position)),
      db.select().from(packItems).where(eq(packItems.packId, pack.id)).orderBy(asc(packItems.position)),
    ])
    const namesOf = (kind: PackItemRow['kind']) => itemRows.filter((row) => row.kind === kind).map((row) => row.name)
    return { pack, tools: toolRows, playbooks: namesOf('playbook'), manuals: namesOf('manual') }
  }
  const touch = (packId: string) =>
    db.update(packs).set({ updatedAt: new Date().toISOString() }).where(eq(packs.id, packId))
  const nextPosition = async (table: typeof packTools | typeof packItems, packId: string) => {
    const [row] = await db
      .select({ top: sql<number>`coalesce(max(${table.position}), -1)` })
      .from(table)
      .where(eq(table.packId, packId))
    return Number(row?.top ?? -1) + 1
  }
  const get = async (name: string) => (await db.select().from(packs).where(eq(packs.name, name)))[0]
  const byId = async (id: string) => (await db.select().from(packs).where(eq(packs.id, id)))[0]
  const formerName = async (name: string) => (await db.select().from(packNames).where(eq(packNames.name, name)))[0]

  return {
    list: () => db.select().from(packs).orderBy(asc(packs.title)),
    /** Takes a removed upstream's tools, playbooks and manuals out of every pack. */
    forgetUpstream: async (upstreamId: string, items: { kind: PackItemRow['kind']; name: string }[]) => {
      await db.delete(packTools).where(like(packTools.toolName, `${upstreamId}.%`))
      for (const item of items)
        await db.delete(packItems).where(and(eq(packItems.kind, item.kind), eq(packItems.name, item.name)))
    },
    get,
    byId,
    /** The pack a name leads to: the one named so now (`until: null`), else the one that was, and until when. */
    holderOf: async (name: string): Promise<{ pack: PackRow; until: string | null } | undefined> => {
      const named = await get(name)
      if (named) return { pack: named, until: null }
      const former = await formerName(name)
      const pack = former && (await byId(former.packId))
      return pack && former ? { pack, until: former.until } : undefined
    },
    /** For a name a pack used to have: the name it has now. Nothing for any other name, the pack's own included. */
    currentNameOf: async (name: string) => {
      const former = await formerName(name)
      const current = former && (await byId(former.packId))?.name
      return current === name ? undefined : current
    },
    /** The names a pack used to have that still lead to it, newest first. */
    formerNames: (packId: string) =>
      db
        .select()
        .from(packNames)
        .where(eq(packNames.packId, packId))
        .orderBy(desc(packNames.until), asc(packNames.name)),
    /**
     * Gives a pack another name; with `keepOld`, the one it had keeps leading to it. Its own old name comes back.
     * The old name is held before the new one is taken, so it is never free in between; when the new one was taken
     * meanwhile, the hold is undone and the failure thrown.
     */
    rename: async (pack: PackRow, to: string, keepOld: boolean) => {
      const now = new Date().toISOString()
      await db.delete(packNames).where(eq(packNames.name, to))
      if (keepOld)
        await db
          .insert(packNames)
          .values({ name: pack.name, packId: pack.id, until: now })
          .onConflictDoUpdate({ target: packNames.name, set: { packId: pack.id, until: now } })
      try {
        await db.update(packs).set({ name: to, updatedAt: now }).where(eq(packs.id, pack.id))
      } catch (error) {
        if ((await byId(pack.id))?.name === pack.name)
          await db.delete(packNames).where(and(eq(packNames.name, pack.name), eq(packNames.packId, pack.id)))
        throw error
      }
    },
    /** Stops an old name leading to a pack; false when it wasn't one of its names. */
    freeName: async (packId: string, name: string) => {
      const former = await formerName(name)
      if (former?.packId !== packId) return false
      await db.delete(packNames).where(eq(packNames.name, name))
      return true
    },
    contentsOf,
    /** Every pack's tools with wording, for the flags across packs. */
    reworded: () =>
      db
        .select({ pack: packs, tool: packTools })
        .from(packTools)
        .innerJoin(packs, eq(packs.id, packTools.packId))
        .where(sql`${packTools.description} is not null`)
        .orderBy(asc(packs.title), asc(packTools.position)),
    /** Every pack tool with fixed inputs, for the flags when an upstream drops one. */
    fixing: () =>
      db
        .select({ pack: packs, tool: packTools })
        .from(packTools)
        .innerJoin(packs, eq(packs.id, packTools.packId))
        .where(sql`${packTools.fixed} is not null`)
        .orderBy(asc(packs.title), asc(packTools.position)),
    create: async (draft: PackDraft) => {
      const id = `pk_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const now = new Date().toISOString()
      await db.insert(packs).values({ id, ...draft, createdAt: now, updatedAt: now })
      return id
    },
    update: async (packId: string, change: Partial<Omit<PackDraft, 'name'>>) => {
      if (Object.keys(change).length)
        await db
          .update(packs)
          .set({ ...change, updatedAt: new Date().toISOString() })
          .where(eq(packs.id, packId))
    },
    /** Notes the owner's first try of the pack, once; not a change to the pack, so `updatedAt` stays. */
    markTried: (packId: string) =>
      db
        .update(packs)
        .set({ triedAt: new Date().toISOString() })
        .where(and(eq(packs.id, packId), isNull(packs.triedAt))),
    remove: async (packId: string) => {
      await db.delete(packTools).where(eq(packTools.packId, packId))
      await db.delete(packItems).where(eq(packItems.packId, packId))
      await db.delete(packNames).where(eq(packNames.packId, packId))
      await db.delete(packs).where(eq(packs.id, packId))
    },
    /** Adds tools at the end; a name already in (the alias, else the tool's) keeps its place, wording and reason. */
    addTools: async (packId: string, drafts: PackToolDraft[]) => {
      const have = new Set(
        (await db.select().from(packTools).where(eq(packTools.packId, packId))).map((row) => row.name),
      )
      let position = await nextPosition(packTools, packId)
      const fresh = drafts.filter((draft) => {
        const name = draft.alias ?? draft.name
        return !have.has(name) && have.add(name)
      })
      if (fresh.length)
        await db.insert(packTools).values(
          fresh.map((draft) => ({
            packId,
            name: draft.alias ?? draft.name,
            toolName: draft.name,
            position: position++,
            description: null,
            basedOn: null,
            reason: draft.reason,
            via: draft.via ?? null,
            fixed: fixedText(draft.fixed),
          })),
        )
      await touch(packId)
      return fresh.length
    },
    /** Removes by the names the pack's keys call them. */
    removeTools: async (packId: string, names: string[]) => {
      if (names.length)
        await db.delete(packTools).where(and(eq(packTools.packId, packId), inArray(packTools.name, names)))
      await touch(packId)
    },
    /** Renames one pack tool (null alias: back to the tool's own name) or changes what it fixes. */
    setEntry: async (packId: string, name: string, change: { name?: string; fixed?: Fixed | null }) => {
      await db
        .update(packTools)
        .set({
          ...(change.name === undefined ? {} : { name: change.name }),
          ...(change.fixed === undefined ? {} : { fixed: fixedText(change.fixed) }),
        })
        .where(and(eq(packTools.packId, packId), eq(packTools.name, name)))
      await touch(packId)
    },
    /** The pack's wording for one tool (null goes back to the upstream's), written against `basedOn`. */
    setWording: async (packId: string, name: string, description: string | null, basedOn: string | null) => {
      await db
        .update(packTools)
        .set({ description, basedOn: description === null ? null : basedOn })
        .where(and(eq(packTools.packId, packId), eq(packTools.name, name)))
      await touch(packId)
    },
    addItems: async (packId: string, kind: PackItemRow['kind'], names: string[]) => {
      const have = new Set(
        (
          await db
            .select()
            .from(packItems)
            .where(and(eq(packItems.packId, packId), eq(packItems.kind, kind)))
        ).map((row) => row.name),
      )
      let position = await nextPosition(packItems, packId)
      const fresh = names.filter((name) => !have.has(name) && have.add(name))
      if (fresh.length)
        await db.insert(packItems).values(fresh.map((name) => ({ packId, kind, name, position: position++ })))
      await touch(packId)
    },
    removeItems: async (packId: string, kind: PackItemRow['kind'], names: string[]) => {
      if (names.length)
        await db
          .delete(packItems)
          .where(and(eq(packItems.packId, packId), eq(packItems.kind, kind), inArray(packItems.name, names)))
      await touch(packId)
    },
  }
}

export type PacksRepo = ReturnType<typeof packsRepo>
