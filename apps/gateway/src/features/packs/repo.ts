/**
 * Packs, their tools, variables, playbooks and manuals, and the playbooks and skill written for them: the only
 * queries on these tables. A pack's own document is only ever read by its pack's id, never by its name alone.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, like, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../../kit/index.js'
import type { Fixed } from './entries.js'
import {
  type PackDocKind,
  type PackDocSource,
  type PackItemRow,
  type PackReason,
  type PackRow,
  type PackToolRow,
  type PackVariableRow,
  packDocs,
  packDocVersions,
  packItems,
  packNames,
  packs,
  packTools,
  packVariables,
} from './schema.js'
import type { Scalar } from './values.js'

export type PackDraft = { name: string; title: string; description: string }
/** A tool to add: `name` is the tool (`<upstream>.<tool>`); `alias` is what the pack's keys call it instead. */
export type PackToolDraft = {
  name: string
  reason: PackReason
  via?: string | null
  alias?: string | null
  fixed?: Fixed | null
  defaults?: Fixed | null
}
export type PackVariableDraft = { name: string; value: Scalar; description?: string | null }

const fixedText = (fixed: Fixed | null | undefined) =>
  fixed && Object.keys(fixed).length ? JSON.stringify(fixed) : null

/**
 * The tools a document names, by the pack's names, each with the tool version that was live when it was saved
 * (null for a tool that was not live then).
 */
export type BasedOn = Record<string, string | null>
/** A pack's own playbook or its skill, as served: its newest text. */
export type PackDoc = {
  kind: PackDocKind
  name: string
  body: string
  basedOn: BasedOn
  versionId: string
  source: PackDocSource
  createdAt: string
  updatedAt: string
}
export type PackDocDraft = { body: string; basedOn: BasedOn; source: PackDocSource }

/** A pack with everything in it, in order. */
export type PackContents = {
  pack: PackRow
  tools: PackToolRow[]
  variables: PackVariableRow[]
  playbooks: string[]
  manuals: string[]
  /** The playbooks and the skill written for it. */
  docs: PackDoc[]
}

export const packsRepo = (db: Db) => {
  const variablesOf = (packId: string) =>
    db.select().from(packVariables).where(eq(packVariables.packId, packId)).orderBy(asc(packVariables.position))
  /** Documents joined to the version each serves, a pack's in the order they were first saved. */
  const liveDocs = () =>
    db
      .select({ doc: packDocs, version: packDocVersions, pack: packs })
      .from(packDocs)
      .innerJoin(packDocVersions, eq(packDocVersions.id, packDocs.liveVersion))
      .innerJoin(packs, eq(packs.id, packDocs.packId))
  const docOf = ({
    doc,
    version,
  }: {
    doc: typeof packDocs.$inferSelect
    version: typeof packDocVersions.$inferSelect
  }): PackDoc => ({
    kind: doc.kind,
    name: doc.name,
    body: version.body,
    basedOn: JSON.parse(version.basedOn) as BasedOn,
    versionId: version.id,
    source: version.source,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  })
  const docsOf = async (packId: string) =>
    (await liveDocs().where(eq(packDocs.packId, packId)).orderBy(asc(packDocs.position))).map(docOf)
  const ofDoc = (table: typeof packDocs | typeof packDocVersions, packId: string, kind: PackDocKind, name: string) =>
    and(eq(table.packId, packId), eq(table.kind, kind), eq(table.name, name))
  const doc = async (packId: string, kind: PackDocKind, name: string) =>
    (await liveDocs().where(ofDoc(packDocs, packId, kind, name))).map(docOf)[0]
  const contentsOf = async (pack: PackRow): Promise<PackContents> => {
    const [toolRows, variables, itemRows, docs] = await Promise.all([
      db.select().from(packTools).where(eq(packTools.packId, pack.id)).orderBy(asc(packTools.position)),
      variablesOf(pack.id),
      db.select().from(packItems).where(eq(packItems.packId, pack.id)).orderBy(asc(packItems.position)),
      docsOf(pack.id),
    ])
    const namesOf = (kind: PackItemRow['kind']) => itemRows.filter((row) => row.kind === kind).map((row) => row.name)
    return { pack, tools: toolRows, variables, playbooks: namesOf('playbook'), manuals: namesOf('manual'), docs }
  }
  const touch = (packId: string) =>
    db.update(packs).set({ updatedAt: new Date().toISOString() }).where(eq(packs.id, packId))
  const nextPosition = async (table: typeof packTools | typeof packItems | typeof packDocs, packId: string) => {
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
    /** Every pack tool that fixes an input or gives one a default, for the flags when a value stops fitting. */
    fixing: () =>
      db
        .select({ pack: packs, tool: packTools })
        .from(packTools)
        .innerJoin(packs, eq(packs.id, packTools.packId))
        .where(sql`${packTools.fixed} is not null or ${packTools.defaults} is not null`)
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
      await db.delete(packVariables).where(eq(packVariables.packId, packId))
      await db.delete(packNames).where(eq(packNames.packId, packId))
      await db.delete(packDocs).where(eq(packDocs.packId, packId))
      await db.delete(packDocVersions).where(eq(packDocVersions.packId, packId))
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
            defaults: fixedText(draft.defaults),
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
    /** Renames one pack tool (null alias: back to the tool's own name) or changes what it fixes or defaults. */
    setEntry: async (
      packId: string,
      name: string,
      change: { name?: string; fixed?: Fixed | null; defaults?: Fixed | null },
    ) => {
      await db
        .update(packTools)
        .set({
          ...(change.name === undefined ? {} : { name: change.name }),
          ...(change.fixed === undefined ? {} : { fixed: fixedText(change.fixed) }),
          ...(change.defaults === undefined ? {} : { defaults: fixedText(change.defaults) }),
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
    variablesOf,
    /**
     * Replaces the pack's variables with these, in this order. The kept and the new are written before the rest are
     * removed, so a request that builds a pack lock meanwhile never finds a variable missing that the pack keeps.
     */
    setVariables: async (packId: string, drafts: PackVariableDraft[]) => {
      const ofPack = eq(packVariables.packId, packId)
      if (drafts.length)
        await db
          .insert(packVariables)
          .values(
            drafts.map((draft, position) => ({
              packId,
              name: draft.name,
              value: JSON.stringify(draft.value),
              description: draft.description ?? null,
              position,
            })),
          )
          .onConflictDoUpdate({
            target: [packVariables.packId, packVariables.name],
            set: {
              value: sql`excluded.value`,
              description: sql`excluded.description`,
              position: sql`excluded.position`,
            },
          })
      const names = drafts.map((draft) => draft.name)
      await db.delete(packVariables).where(names.length ? and(ofPack, notInArray(packVariables.name, names)) : ofPack)
      await touch(packId)
    },
    /** Adds variables at the end; a name the pack already has keeps its value. */
    addVariables: async (packId: string, drafts: PackVariableDraft[]) => {
      const rows = await variablesOf(packId)
      const have = new Set(rows.map((row) => row.name))
      const fresh = drafts.filter((draft) => !have.has(draft.name) && have.add(draft.name))
      let position = Math.max(-1, ...rows.map((row) => row.position)) + 1
      if (fresh.length) {
        await db.insert(packVariables).values(
          fresh.map((draft) => ({
            packId,
            name: draft.name,
            value: JSON.stringify(draft.value),
            description: draft.description ?? null,
            position: position++,
          })),
        )
        await touch(packId)
      }
      return fresh.length
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
    docsOf,
    doc,
    /** Every pack's documents, for the flags across packs. */
    allDocs: async () =>
      (await liveDocs().orderBy(asc(packs.title), asc(packDocs.position))).map((row) => ({
        pack: row.pack,
        doc: docOf(row),
      })),
    /**
     * Saves a document's text as its newest version. The text it already serves adds no version: only the tool
     * versions it stands on are noted anew, which is how the owner keeps a text after a tool changed.
     */
    saveDoc: async (packId: string, kind: PackDocKind, name: string, draft: PackDocDraft) => {
      const basedOn = JSON.stringify(draft.basedOn)
      const had = await doc(packId, kind, name)
      if (had?.body === draft.body) {
        await db.update(packDocVersions).set({ basedOn }).where(eq(packDocVersions.id, had.versionId))
        return { versionId: had.versionId, added: false }
      }
      const versionId = `pdv_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const now = new Date().toISOString()
      await db
        .insert(packDocVersions)
        .values({ id: versionId, packId, kind, name, body: draft.body, basedOn, source: draft.source, createdAt: now })
      await db
        .insert(packDocs)
        .values({
          packId,
          kind,
          name,
          liveVersion: versionId,
          position: had ? 0 : await nextPosition(packDocs, packId),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [packDocs.packId, packDocs.kind, packDocs.name],
          set: { liveVersion: versionId, updatedAt: now },
        })
      await touch(packId)
      return { versionId, added: true }
    },
    /** Removes a document with every version of it; false when the pack had none of that name. */
    removeDoc: async (packId: string, kind: PackDocKind, name: string) => {
      if (!(await doc(packId, kind, name))) return false
      await db.delete(packDocs).where(ofDoc(packDocs, packId, kind, name))
      await db.delete(packDocVersions).where(ofDoc(packDocVersions, packId, kind, name))
      await touch(packId)
      return true
    },
    /** Every text a document had, newest first. */
    docVersions: (packId: string, kind: PackDocKind, name: string) =>
      db
        .select()
        .from(packDocVersions)
        .where(ofDoc(packDocVersions, packId, kind, name))
        .orderBy(desc(packDocVersions.createdAt), desc(sql`${packDocVersions}.rowid`)),
    /** One version, only as a version of this document. */
    docVersion: async (packId: string, kind: PackDocKind, name: string, id: string) =>
      (
        await db
          .select()
          .from(packDocVersions)
          .where(and(ofDoc(packDocVersions, packId, kind, name), eq(packDocVersions.id, id)))
      )[0],
  }
}

export type PacksRepo = ReturnType<typeof packsRepo>
