/**
 * The daily usage report (docs/telemetry.md): how far this instance is set up and how much it is used, as ranges and
 * yes/no answers. Never a name, an address, a query, a key or anything a call carried. The field list is schema 1 of
 * `yardhand` at the receiving end, which refuses a report that carries anything else.
 */
import { sql } from 'drizzle-orm'
import type { Db } from '../../kit/index.js'

/** What the report reads: named here, apart from the services, so the services can hold telemetry without a circle. */
export type Source = {
  db: Db
  tools: { pending: () => Promise<unknown[]> }
  catalog: { pending: () => Promise<unknown[]> }
  publicOrigin: string
  meaning: unknown
  ai: { grouping: () => Promise<{ key: { value: string }; provider: { value: string } }> }
  traces: unknown
  env: { DISCORD_WEBHOOK_URL?: string; ACCESS_TEAM?: string; ACCESS_AUD?: string }
}

export const SCHEMA = 1

const COUNT_STEPS: [number, string][] = [
  [0, '0'],
  [10, '1-10'],
  [100, '11-100'],
  [1000, '101-1k'],
  [10_000, '1k-10k'],
]
/** A count as a range, so a report can't single out an instance by its exact numbers. */
export const countRange = (count: number) => COUNT_STEPS.find(([upTo]) => count <= upTo)?.[1] ?? '10k+'

const DAY_STEPS: [number, string][] = [
  [0, '0'],
  [7, '1-7'],
  [30, '8-30'],
  [90, '31-90'],
  [365, '91-365'],
]
export const daysRange = (days: number) => DAY_STEPS.find(([upTo]) => days <= upTo)?.[1] ?? '365+'

const MEGABYTE = 1_000_000
export const sizeRange = (bytes: number) =>
  bytes < 10 * MEGABYTE ? '<10MB' : bytes < 100 * MEGABYTE ? '10-100MB' : bytes < 1000 * MEGABYTE ? '100MB-1GB' : '1GB+'

const INSTALLS = ['compose', 'cloud-init', 'render', 'fly', 'source']
const ARCHS = ['x64', 'arm64']
const DAY = 24 * 60 * 60 * 1000

/** The counts, in the order the query selects them (the database answers a raw query with bare rows). */
const COUNTS = [
  'connections',
  'mcp',
  'http',
  'composio',
  'tools',
  'keys',
  'oauth',
  'packs',
  'calls1d',
  'calls',
  'viaMcp',
  'viaRest',
  'viaApp',
  'toolError',
  'refused',
  'failed',
  'searches',
  'active',
] as const
type Counts = Record<(typeof COUNTS)[number], number>

export type Facts = {
  /** When this instance first could report (ISO). */
  since: string
  claimed: boolean
  install: string | undefined
  arch: string
  databaseBytes: number
}

export const buildReport = async (
  { db, tools, catalog, publicOrigin, meaning, ai, traces, env }: Source,
  facts: Facts,
  now = new Date(),
) => {
  const dayAgo = new Date(now.getTime() - DAY).toISOString()
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString()
  const [row] = await db.all<number[] | Counts>(sql`select
    (select count(*) from upstreams) as connections,
    (select count(*) from upstreams where kind = 'mcp') as mcp,
    (select count(*) from upstreams where kind = 'http') as http,
    (select count(*) from upstreams where kind = 'composio') as composio,
    (select count(*) from tools where removed_at is null) as tools,
    (select count(*) from clients where kind = 'key' and revoked_at is null) as keys,
    (select count(*) from clients where kind = 'oauth' and revoked_at is null) as oauth,
    (select count(*) from packs) as packs,
    (select count(*) from calls where created_at >= ${dayAgo}) as calls1d,
    (select count(*) from calls where created_at >= ${weekAgo}) as calls,
    (select count(*) from calls where created_at >= ${weekAgo} and via = 'mcp') as viaMcp,
    (select count(*) from calls where created_at >= ${weekAgo} and via in ('rest', 'passthrough')) as viaRest,
    (select count(*) from calls where created_at >= ${weekAgo} and via = 'app') as viaApp,
    (select count(*) from calls where created_at >= ${weekAgo} and status = 'tool_error') as toolError,
    (select count(*) from calls where created_at >= ${weekAgo} and status = 'refused') as refused,
    (select count(*) from calls where created_at >= ${weekAgo} and status = 'failed') as failed,
    (select count(*) from searches where created_at >= ${weekAgo}) as searches,
    (select count(distinct client_id) from calls where created_at >= ${weekAgo}) as active`)
  if (!row) throw new Error('The counts came back empty')
  const counts = Array.isArray(row)
    ? (Object.fromEntries(COUNTS.map((name, index) => [name, Number(row[index])])) as Counts)
    : row
  for (const name of COUNTS)
    if (!Number.isInteger(counts[name])) throw new Error(`The count of ${name} came back empty`)
  const waiting = (await tools.pending()).length + (await catalog.pending()).length
  const grouping = await ai.grouping()
  return {
    install: facts.install && INSTALLS.includes(facts.install) ? facts.install : 'other',
    arch: ARCHS.includes(facts.arch) ? facts.arch : 'other',
    age: daysRange(Math.floor((now.getTime() - new Date(facts.since).getTime()) / DAY)),
    https: publicOrigin.startsWith('https://'),
    database: sizeRange(facts.databaseBytes),
    claimed: facts.claimed,
    connections: countRange(counts.connections),
    connections_mcp: counts.mcp > 0,
    connections_http: counts.http > 0,
    connections_composio: counts.composio > 0,
    tools: countRange(counts.tools),
    clients_key: countRange(counts.keys),
    clients_oauth: countRange(counts.oauth),
    packs: countRange(counts.packs),
    reviews_waiting: countRange(waiting),
    calls_1d: countRange(counts.calls1d),
    calls: countRange(counts.calls),
    calls_mcp: countRange(counts.viaMcp),
    calls_rest: countRange(counts.viaRest),
    calls_app: countRange(counts.viaApp),
    calls_tool_error: countRange(counts.toolError),
    calls_refused: countRange(counts.refused),
    calls_failed: countRange(counts.failed),
    searches: countRange(counts.searches),
    clients_active: countRange(counts.active),
    meaning_search: Boolean(meaning),
    ai_grouping: grouping.key.value ? grouping.provider.value : 'off',
    langfuse: Boolean(traces),
    discord: Boolean(env.DISCORD_WEBHOOK_URL),
    access_signin: Boolean(env.ACCESS_TEAM && env.ACCESS_AUD),
  }
}

export type Report = Awaited<ReturnType<typeof buildReport>>
