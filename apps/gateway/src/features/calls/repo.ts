/** The call log and held results: the only queries on them. */
import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq, gt, gte, inArray, lt, ne, or, type SQL, sql } from 'drizzle-orm'
import type { Db } from '../../kit/index.js'
import { seal, unseal } from '../vault/crypto.js'
import { type CallRow, callPayloads, calls, handedLinks, heldResults } from './schema.js'

const HOLD_MS = 60 * 60 * 1000
const PAYLOAD_MS = 30 * 24 * 60 * 60 * 1000
const HANDED_MS = 24 * 60 * 60 * 1000
const hashOf = (link: string) => createHash('sha256').update(link).digest('base64url')
/** The owner's principal id in the log. */
const OWNER_ID = 'owner'

export type CallFilter = {
  clientId?: string
  /** Any of these clients (a pack's keys); an empty list matches nothing. */
  clientIds?: string[]
  tool?: string
  upstreamId?: string
  status?: CallRow['status'][]
  via?: CallRow['via']
  kind?: CallRow['kind'][]
  since?: string
  until?: string
}

const filtersOf = ({ clientId, clientIds, tool, upstreamId, status, via, kind, since, until }: CallFilter) => [
  clientId ? eq(calls.clientId, clientId) : undefined,
  clientIds ? (clientIds.length ? inArray(calls.clientId, clientIds) : sql`0`) : undefined,
  tool ? eq(calls.tool, tool) : undefined,
  upstreamId ? eq(calls.upstreamId, upstreamId) : undefined,
  status?.length ? inArray(calls.status, status) : undefined,
  via ? eq(calls.via, via) : undefined,
  kind?.length ? inArray(calls.kind, kind) : undefined,
  since ? gte(calls.createdAt, since) : undefined,
  until ? lt(calls.createdAt, until) : undefined,
]

const median = (values: number[]) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? 0
  return sorted.length % 2 ? upper : Math.round(((sorted[middle - 1] ?? upper) + upper) / 2)
}

export const callsRepo = (db: Db, key: Buffer) => ({
  record: async (
    row: Omit<CallRow, 'id' | 'createdAt' | 'kind' | 'traceId'> & { kind?: CallRow['kind']; traceId?: string | null },
  ) => {
    const id = `call_${randomUUID().replaceAll('-', '').slice(0, 20)}`
    await db.insert(calls).values({ ...row, id, createdAt: new Date().toISOString() })
    return id
  },
  get: async (id: string) => (await db.select().from(calls).where(eq(calls.id, id)))[0],
  /** Newest first; `after` is the last row of the previous page. Every filter is optional. */
  page: ({ after, limit, ...filter }: CallFilter & { after?: { createdAt: string; id: string }; limit: number }) => {
    const filters = [
      ...filtersOf(filter),
      after
        ? or(lt(calls.createdAt, after.createdAt), and(eq(calls.createdAt, after.createdAt), lt(calls.id, after.id)))
        : undefined,
    ].filter(Boolean) as SQL[]
    return db
      .select()
      .from(calls)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(calls.createdAt), desc(calls.id))
      .limit(limit)
  },
  /** Every tool call matching the filter, the fields the stats need (the log keeps 90 days). */
  window: (filter: CallFilter) =>
    db
      .select({
        status: calls.status,
        durationMs: calls.durationMs,
        createdAt: calls.createdAt,
        tool: calls.tool,
        clientId: calls.clientId,
        clientName: calls.clientName,
        upstreamId: calls.upstreamId,
      })
      .from(calls)
      .where(and(eq(calls.kind, 'tool'), ...(filtersOf(filter).filter(Boolean) as SQL[]))),
  /** The first of these tools the client called in the window, if any. */
  firstCallOf: async (clientId: string, toolNames: string[], from: string, to: string) =>
    toolNames.length
      ? (
          await db
            .select({ tool: calls.tool })
            .from(calls)
            .where(
              and(
                eq(calls.clientId, clientId),
                inArray(calls.tool, toolNames),
                gt(calls.createdAt, from),
                lt(calls.createdAt, to),
              ),
            )
            .orderBy(calls.createdAt)
            .limit(1)
        )[0]?.tool
      : undefined,
  /** Calls since a moment, counted per client: how many, and the newest. */
  byClient: (since: string) =>
    db
      .select({ clientId: calls.clientId, count: sql<number>`count(*)`, lastAt: sql<string>`max(${calls.createdAt})` })
      .from(calls)
      .where(gte(calls.createdAt, since))
      .groupBy(calls.clientId),
  /** Each client's newest call ever (within the log's 90 days). */
  lastByClient: () =>
    db
      .select({ clientId: calls.clientId, lastAt: sql<string>`max(${calls.createdAt})` })
      .from(calls)
      .groupBy(calls.clientId),
  /** Tool calls since a moment, counted per upstream, with the durations of the ones that reached it. */
  byUpstream: async (since: string) => {
    const rows = await db
      .select({ upstreamId: calls.upstreamId, status: calls.status, durationMs: calls.durationMs })
      .from(calls)
      .where(and(gte(calls.createdAt, since), eq(calls.kind, 'tool')))
    const byId = new Map<string, { count: number; failed: number; durations: number[] }>()
    for (const row of rows) {
      if (!row.upstreamId) continue
      const entry = byId.get(row.upstreamId) ?? { count: 0, failed: 0, durations: [] }
      entry.count++
      if (row.status === 'failed') entry.failed++
      if (row.status === 'ok' || row.status === 'tool_error') entry.durations.push(row.durationMs)
      byId.set(row.upstreamId, entry)
    }
    return new Map(
      [...byId].map(([id, entry]) => [
        id,
        { count: entry.count, failed: entry.failed, p50Ms: median(entry.durations) },
      ]),
    )
  },
  /** Tool calls since a moment, counted per tool, most used first (reads have their own count). */
  byTool: (since: string, limit = 2000) =>
    db
      .select({ tool: calls.tool, count: sql<number>`count(*)` })
      .from(calls)
      .where(and(gte(calls.createdAt, since), eq(calls.kind, 'tool')))
      .groupBy(calls.tool)
      .orderBy(desc(sql`count(*)`))
      .limit(limit),
  /** Tool calls since a moment, per hour (`2026-11-07T21`) or per day (`2026-11-07`), by how they ended. */
  series: (since: string, bucket: 'hour' | 'day') => {
    const at = sql<string>`substr(${calls.createdAt}, 1, ${bucket === 'hour' ? 13 : 10})`
    return db
      .select({ at, status: calls.status, count: sql<number>`count(*)` })
      .from(calls)
      .where(and(gte(calls.createdAt, since), eq(calls.kind, 'tool')))
      .groupBy(at, calls.status)
  },
  /** The first call made by anyone but the owner, and the owner's first run from the app: the activation marks. */
  firsts: async () => {
    const agent = await db
      .select({ at: sql<string | null>`min(${calls.createdAt})` })
      .from(calls)
      .where(ne(calls.clientId, OWNER_ID))
    const tried = await db
      .select({ at: sql<string | null>`min(${calls.createdAt})` })
      .from(calls)
      .where(and(eq(calls.clientId, OWNER_ID), inArray(calls.status, ['ok', 'tool_error'])))
    return { agentCallAt: agent[0]?.at ?? null, ownerRunAt: tried[0]?.at ?? null }
  },
  /** Did this client call any of these tools in the window (after a search that found them)? */
  /** Agents' reads since a moment (not the owner's in the app): manuals, playbooks and links, per item. */
  readsSince: (since: string) =>
    db
      .select({ kind: calls.kind, tool: calls.tool, upstreamId: calls.upstreamId, count: sql<number>`count(*)` })
      .from(calls)
      .where(and(gte(calls.createdAt, since), ne(calls.kind, 'tool'), ne(calls.via, 'app'), eq(calls.status, 'ok')))
      .groupBy(calls.kind, calls.tool, calls.upstreamId),
  calledAnyOf: async (clientId: string, toolNames: string[], from: string, to: string) =>
    (
      await db
        .select({ id: calls.id })
        .from(calls)
        .where(
          and(
            eq(calls.clientId, clientId),
            inArray(calls.tool, toolNames),
            gt(calls.createdAt, from),
            lt(calls.createdAt, to),
          ),
        )
        .limit(1)
    ).length > 0,
  /** Drops calls older than `before`, and every expired held result and payload. */
  prune: async (before: string) => {
    const now = new Date().toISOString()
    await db.delete(calls).where(lt(calls.createdAt, before))
    await db.delete(heldResults).where(lt(heldResults.expiresAt, now))
    await db.delete(callPayloads).where(lt(callPayloads.expiresAt, now))
    await db.delete(handedLinks).where(lt(handedLinks.expiresAt, now))
  },
  /** Notes links a client was handed in a result; each opens for a day from the last time it was handed. */
  hand: async (clientId: string, links: string[]) => {
    const expiresAt = new Date(Date.now() + HANDED_MS).toISOString()
    const rows = [...new Set(links.map(hashOf))].map((hash) => ({ clientId, hash, expiresAt }))
    for (let at = 0; at < rows.length; at += 200)
      await db
        .insert(handedLinks)
        .values(rows.slice(at, at + 200))
        .onConflictDoUpdate({ target: [handedLinks.clientId, handedLinks.hash], set: { expiresAt } })
  },
  /** Was this client handed this link within the last day? */
  wasHanded: async (clientId: string, link: string) => {
    const [row] = await db
      .select({ expiresAt: handedLinks.expiresAt })
      .from(handedLinks)
      .where(and(eq(handedLinks.clientId, clientId), eq(handedLinks.hash, hashOf(link))))
    return Boolean(row && row.expiresAt > new Date().toISOString())
  },
  /** Seals what a call sent and got back, kept 30 days. */
  keepPayload: (
    callId: string,
    payload: { arguments: unknown; result?: unknown; error?: string; asked?: unknown; answers?: unknown },
  ) =>
    db.insert(callPayloads).values({
      callId,
      sealed: seal(key, JSON.stringify(payload)),
      expiresAt: new Date(Date.now() + PAYLOAD_MS).toISOString(),
    }),
  payload: async (callId: string) => {
    const row = (await db.select().from(callPayloads).where(eq(callPayloads.callId, callId)))[0]
    if (!row || row.expiresAt < new Date().toISOString()) return undefined
    return JSON.parse(unseal(key, row.sealed)) as { arguments: unknown; result?: unknown; error?: string }
  },
  hold: async (callId: string, text: string, pageChars: number) => {
    const now = new Date()
    await db.delete(heldResults).where(lt(heldResults.expiresAt, now.toISOString()))
    const pages = Math.max(1, Math.ceil(text.length / pageChars))
    await db.insert(heldResults).values({
      callId,
      sealed: seal(key, text),
      pageChars,
      pages,
      expiresAt: new Date(now.getTime() + HOLD_MS).toISOString(),
    })
    return pages
  },
  /** One page of a held result, or undefined when it expired or never existed. */
  heldPage: async (callId: string, page: number) => {
    const row = (await db.select().from(heldResults).where(eq(heldResults.callId, callId)))[0]
    if (!row || row.expiresAt < new Date().toISOString()) return undefined
    const text = unseal(key, row.sealed)
    return {
      page,
      pages: row.pages,
      expiresAt: row.expiresAt,
      text: text.slice((page - 1) * row.pageChars, page * row.pageChars),
    }
  },
})

export type CallsRepo = ReturnType<typeof callsRepo>
