/** Tools and their versions, and the keyword index over live versions: the only queries on these tables. */
import { createHash, randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import type { Db } from '../../kit/index.js'
import { effectOf, type GroupDraft } from './groups.js'
import {
  type Effect,
  effectSwitches,
  type ToolGroupRow,
  type ToolRow,
  toolGroupMembers,
  toolGroups,
  tools,
  toolVersions,
  type VersionRow,
} from './schema.js'
import { ftsQuery } from './words.js'

export type ToolDefinition = {
  title?: string | null
  description?: string | null
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown> | null
  annotations?: Record<string, unknown> | null
}

/** The owner's say over a tool: it only reads, it changes things, or it is switched off for everyone. */
export type ToolAccess = 'read' | 'write' | 'off'

/** A tool as served: its row and its live version, schemas parsed. */
export type LiveTool = {
  name: string
  upstreamId: string
  remoteName: string
  versionId: string
  title: string | null
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown> | null
  annotations: Record<string, unknown>
  /** What applies: the owner's own setting, else `off` when its group or its effect is switched off, else null. */
  access: ToolAccess | null
  /** The owner's own setting on this tool, which wins over its group and effect. */
  ownAccess: ToolAccess | null
  /** Why it is off, when it is: the owner switched it off, its group, or its effect. */
  offBy: 'you' | 'group' | 'effect' | null
  group: { key: string; title: string } | null
  /** `GET /api/v1/explore/seasonal`: the route behind it, when its upstream says. */
  route: string | null
}

/** Identical definitions hash the same whatever the key order. */
const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
        )
      : value

export const hashDefinition = (definition: ToolDefinition) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        stable({
          ...definition,
          title: definition.title ?? null,
          outputSchema: definition.outputSchema ?? null,
          annotations: definition.annotations ?? {},
        }),
      ),
    )
    .digest('hex')

/** Do these hints say the tool changes something? Unknown means yes: only an explicit read-only hint says no. */
export const hintsWrite = (annotations: Record<string, unknown>) =>
  annotations.readOnlyHint !== true || annotations.destructiveHint === true

/** Does calling this tool need write scope? The owner's setting wins over the upstream's hints. */
export const needsWrite = (tool: Pick<LiveTool, 'access' | 'annotations'>) =>
  tool.access === 'read' ? false : tool.access ? true : hintsWrite(tool.annotations)

/** Switched off by the owner: nobody runs it, and only the owner sees it listed. */
export const isOff = (tool: Pick<LiveTool, 'access'>) => tool.access === 'off'

type LiveRow = { tool: ToolRow; version: VersionRow; group: ToolGroupRow | null }

/** Off connections' effects, as `<upstream>:<effect>`. */
type OffEffects = Set<string>

const liveOf = ({ tool, version, group }: LiveRow, offEffects: OffEffects): LiveTool => {
  const annotations = JSON.parse(version.annotations) as Record<string, unknown>
  const offBy = tool.access
    ? tool.access === 'off'
      ? 'you'
      : null
    : group?.off
      ? 'group'
      : offEffects.has(
            `${tool.upstreamId}:${effectOf({ annotations, remoteName: tool.remoteName, route: tool.route })}`,
          )
        ? 'effect'
        : null
  return {
    name: tool.name,
    upstreamId: tool.upstreamId,
    remoteName: tool.remoteName,
    versionId: version.id,
    title: version.title,
    description: version.description,
    inputSchema: JSON.parse(version.inputSchema),
    outputSchema: version.outputSchema ? JSON.parse(version.outputSchema) : null,
    annotations,
    access: offBy ? 'off' : tool.access,
    ownAccess: tool.access,
    offBy,
    group: group ? { key: group.key, title: group.title } : null,
    route: tool.route,
  }
}

export const toolsRepo = (db: Db) => {
  const liveJoin = (where?: SQL) =>
    db
      .select({ tool: tools, version: toolVersions, group: toolGroups })
      .from(tools)
      .innerJoin(toolVersions, eq(toolVersions.id, tools.liveVersion))
      .leftJoin(toolGroupMembers, eq(toolGroupMembers.toolName, tools.name))
      .leftJoin(
        toolGroups,
        and(eq(toolGroups.upstreamId, toolGroupMembers.upstreamId), eq(toolGroups.key, toolGroupMembers.groupKey)),
      )
      .where(where ? and(isNull(tools.removedAt), where) : isNull(tools.removedAt))
  const offEffects = async (): Promise<OffEffects> =>
    new Set(
      (await db.select().from(effectSwitches).where(eq(effectSwitches.off, true))).map(
        (row) => `${row.upstreamId}:${row.effect}`,
      ),
    )
  const live = async (where?: SQL) => {
    const [rows, off] = await Promise.all([liveJoin(where), offEffects()])
    return rows.map((row) => liveOf(row, off))
  }

  const reindex = async (name: string) => {
    await db.run(sql`delete from tools_fts where name = ${name}`)
    const row = (await liveJoin(eq(tools.name, name)))[0]
    if (row)
      await db.run(
        sql`insert into tools_fts (name, upstream, title, description) values (${name}, ${row.tool.upstreamId}, ${row.version.title ?? ''}, ${row.version.description})`,
      )
  }

  const addVersion = async (toolName: string, definition: ToolDefinition, state: VersionRow['state']) => {
    const id = `tv_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    await db.insert(toolVersions).values({
      id,
      toolName,
      hash: hashDefinition(definition),
      state,
      title: definition.title ?? null,
      description: definition.description ?? '',
      inputSchema: JSON.stringify(definition.inputSchema ?? { type: 'object' }),
      outputSchema: definition.outputSchema ? JSON.stringify(definition.outputSchema) : null,
      annotations: JSON.stringify(definition.annotations ?? {}),
      createdAt: new Date().toISOString(),
    })
    return id
  }

  const makeLive = async (toolName: string, versionId: string) => {
    await db
      .update(toolVersions)
      .set({ state: 'superseded' })
      .where(and(eq(toolVersions.toolName, toolName), eq(toolVersions.state, 'live')))
    await db.update(toolVersions).set({ state: 'live' }).where(eq(toolVersions.id, versionId))
    await db.update(tools).set({ liveVersion: versionId, removedAt: null }).where(eq(tools.name, toolName))
    await reindex(toolName)
  }

  return {
    live: async (name: string) => (await live(eq(tools.name, name)))[0],
    liveMany: async (names: string[]) => {
      if (!names.length) return []
      const byName = new Map((await live(inArray(tools.name, names))).map((tool) => [tool.name, tool]))
      return names.flatMap((name) => byName.get(name) ?? [])
    },
    /** Live tools, by name, from the given upstreams. */
    listLive: async ({ upstreams, limit }: { upstreams: 'all' | string[]; limit: number }) => {
      if (upstreams !== 'all' && !upstreams.length) return []
      const [rows, off] = await Promise.all([
        liveJoin(upstreams === 'all' ? undefined : inArray(tools.upstreamId, upstreams))
          .orderBy(asc(tools.name))
          .limit(limit),
        offEffects(),
      ])
      return rows.map((row) => liveOf(row, off))
    },
    /** A connection's groups, in order. */
    groupsOf: (upstreamId: string) =>
      db.select().from(toolGroups).where(eq(toolGroups.upstreamId, upstreamId)).orderBy(asc(toolGroups.position)),
    /** Which group each of a connection's tools is filed in (retired tools too). */
    membersOf: (upstreamId: string) =>
      db.select().from(toolGroupMembers).where(eq(toolGroupMembers.upstreamId, upstreamId)),
    /** Adds a group at the end, or leaves one with that key as it is. */
    ensureGroup: async (upstreamId: string, group: GroupDraft, source: ToolGroupRow['source']) => {
      const [top] = await db
        .select({ top: sql<number>`coalesce(max(${toolGroups.position}), -1)` })
        .from(toolGroups)
        .where(eq(toolGroups.upstreamId, upstreamId))
      await db
        .insert(toolGroups)
        .values({
          upstreamId,
          key: group.key,
          title: group.title,
          purpose: group.purpose ?? null,
          source,
          off: false,
          position: Number(top?.top ?? -1) + 1,
        })
        .onConflictDoNothing()
    },
    /** Writes a group's name, purpose and place (a regroup); its switch stays as it was. */
    /** Writes a proposed group; one the owner made or named keeps its name and stays theirs. */
    defineGroup: async (upstreamId: string, group: GroupDraft, source: ToolGroupRow['source'], position: number) => {
      const mine = and(eq(toolGroups.upstreamId, upstreamId), eq(toolGroups.key, group.key))
      const [existing] = await db.select().from(toolGroups).where(mine)
      if (existing?.source === 'owner') {
        await db.update(toolGroups).set({ position }).where(mine)
        return
      }
      await db
        .insert(toolGroups)
        .values({
          upstreamId,
          key: group.key,
          title: group.title,
          purpose: group.purpose ?? null,
          source,
          off: false,
          position,
        })
        .onConflictDoUpdate({
          target: [toolGroups.upstreamId, toolGroups.key],
          set: { title: group.title, purpose: group.purpose ?? null, source, position },
        })
    },
    removeGroups: async (upstreamId: string, keys: string[]) => {
      if (keys.length)
        await db.delete(toolGroups).where(and(eq(toolGroups.upstreamId, upstreamId), inArray(toolGroups.key, keys)))
    },
    setGroup: (upstreamId: string, key: string, change: { title?: string; off?: boolean }) =>
      db
        .update(toolGroups)
        .set({ ...change, ...(change.title === undefined ? {} : { source: 'owner' as const }) })
        .where(and(eq(toolGroups.upstreamId, upstreamId), eq(toolGroups.key, key))),
    /** Files a tool in a group; `moved` when the owner put it there. */
    file: (toolName: string, upstreamId: string, groupKey: string, moved = false) =>
      db
        .insert(toolGroupMembers)
        .values({ toolName, upstreamId, groupKey, moved })
        .onConflictDoUpdate({ target: toolGroupMembers.toolName, set: { groupKey, upstreamId, moved } }),
    effectsOf: (upstreamId: string) =>
      db.select().from(effectSwitches).where(eq(effectSwitches.upstreamId, upstreamId)),
    setEffect: (upstreamId: string, effect: Effect, off: boolean) =>
      db
        .insert(effectSwitches)
        .values({ upstreamId, effect, off })
        .onConflictDoUpdate({ target: [effectSwitches.upstreamId, effectSwitches.effect], set: { off } }),
    /** Keyword search over the live tools of these upstreams: names ranked by BM25, best first. */
    searchNames: async (q: string, limit: number, upstreams: string[]) => {
      const match = ftsQuery(q)
      if (!match || !upstreams.length) return []
      const within = sql.join(
        upstreams.map((id) => sql`${id}`),
        sql`, `,
      )
      const rows = await db.all<unknown>(
        sql`select name, bm25(tools_fts, 4.0, 2.0, 3.0, 1.0) as score from tools_fts where tools_fts match ${match} and upstream in (${within}) order by score limit ${limit}`,
      )
      return rows.map((row) => (Array.isArray(row) ? String(row[0]) : String((row as { name: string }).name)))
    },
    ofUpstream: (upstreamId: string) => db.select().from(tools).where(eq(tools.upstreamId, upstreamId)),
    versionsOf: (toolName: string) =>
      db.select().from(toolVersions).where(eq(toolVersions.toolName, toolName)).orderBy(asc(toolVersions.createdAt)),
    version: async (id: string) => (await db.select().from(toolVersions).where(eq(toolVersions.id, id)))[0],
    pending: () =>
      db
        .select({ tool: tools, version: toolVersions })
        .from(toolVersions)
        .innerJoin(tools, eq(tools.name, toolVersions.toolName))
        .where(eq(toolVersions.state, 'pending'))
        .orderBy(asc(toolVersions.createdAt)),
    create: async ({ name, upstreamId, remoteName }: { name: string; upstreamId: string; remoteName: string }) => {
      await db.insert(tools).values({ name, upstreamId, remoteName, createdAt: new Date().toISOString() })
    },
    addVersion,
    makeLive,
    setRoute: (name: string, route: string | null) => db.update(tools).set({ route }).where(eq(tools.name, name)),
    setAccess: (name: string, access: ToolAccess | null) =>
      db.update(tools).set({ access }).where(eq(tools.name, name)),
    setState: (versionId: string, state: VersionRow['state']) =>
      db.update(toolVersions).set({ state }).where(eq(toolVersions.id, versionId)),
    markRemoved: async (name: string) => {
      await db.update(tools).set({ removedAt: new Date().toISOString() }).where(eq(tools.name, name))
      await reindex(name)
    },
    restore: async (name: string) => {
      await db.update(tools).set({ removedAt: null }).where(eq(tools.name, name))
      await reindex(name)
    },
    removeUpstream: async (upstreamId: string) => {
      const names = (await db.select().from(tools).where(eq(tools.upstreamId, upstreamId))).map((row) => row.name)
      await db.delete(toolGroupMembers).where(eq(toolGroupMembers.upstreamId, upstreamId))
      await db.delete(toolGroups).where(eq(toolGroups.upstreamId, upstreamId))
      await db.delete(effectSwitches).where(eq(effectSwitches.upstreamId, upstreamId))
      if (!names.length) return
      await db.delete(toolVersions).where(inArray(toolVersions.toolName, names))
      await db.delete(tools).where(inArray(tools.name, names))
      for (const name of names) await db.run(sql`delete from tools_fts where name = ${name}`)
    },
  }
}

export type ToolsRepo = ReturnType<typeof toolsRepo>
