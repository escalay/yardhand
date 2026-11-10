/** Overview: Home in one call, and the gateway's own state. */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { Context } from 'hono'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import { VERSION } from '../../version.js'
import { requireOwner } from '../clients/principals.js'
import { SERVER_NAME } from '../clients/setup.js'
import type { Feature } from '../index.js'
import { readInstance } from '../instance/keys.js'
import { packFlags } from '../packs/flags.js'
import { findability, unansweredSearches } from '../searches/demand.js'
import { PATH, routes, STATS_PATH, SYSTEM_PATH, TAG } from './routes.js'
import { bucketsOf, nudgesOf, setupOf } from './rules.js'
import { RANGES, statsOf } from './stats.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const outcomesOf = (rows: { status: string; count: number }[]) => {
  const count = (status: string) =>
    rows.filter((row) => row.status === status).reduce((sum, row) => sum + Number(row.count), 0)
  return {
    total: rows.reduce((sum, row) => sum + Number(row.count), 0),
    ok: count('ok'),
    toolErrors: count('tool_error'),
    refused: count('refused'),
    failed: count('failed'),
  }
}

export const feature: Feature = {
  name: 'overview',
  tag: { name: TAG, description: 'Home and Settings in one call each.' },
  migrations: [],
  register: (app, services) => {
    const { upstreams, tools, catalog, clients, calls, searches, db, env, meaning, startedAt, jobs, publicOrigin } =
      services
    const { watcher, packs } = services

    /** Searches that led to a call, and what agents read, over the window. */
    const findabilityOf = async (since: string) => {
      const reads = await calls.readsSince(since)
      const total = (kind: string) =>
        reads.filter((row) => row.kind === kind).reduce((sum, row) => sum + Number(row.count), 0)
      return {
        ...(await findability({ searches, calls }, since)).overall,
        reads: { manual: total('manual'), playbook: total('playbook'), link: total('link') },
        manuals: reads
          .filter((row) => row.kind === 'manual')
          .map((row) => ({ name: row.tool, upstream: row.upstreamId, count: Number(row.count) }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 3),
      }
    }

    app.openapi(routes.overview, async (c) => {
      requireOwner(c)
      const now = new Date()
      const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()
      const [rows, clientRows, pending, firsts, pins, hourly, daily, usage24h, usage30d, lastCalls, topTools] =
        await Promise.all([
          upstreams.list(),
          clients.list(),
          Promise.all([tools.pending(), catalog.pending()]).then(([toolRows, catalogRows]) => [
            ...toolRows,
            ...catalogRows,
          ]),
          calls.firsts(),
          clients.globalPins(),
          calls.series(ago(24 * HOUR_MS), 'hour'),
          calls.series(ago(7 * DAY_MS), 'day'),
          calls.byUpstream(ago(DAY_MS)),
          calls.byUpstream(ago(30 * DAY_MS)),
          calls.lastByClient(),
          calls.byTool(ago(7 * DAY_MS), 5),
        ])
      // Expired keys are as gone as revoked ones: no quiet-key nudges for a session key that ended
      const active = clientRows.filter(
        (row) => !row.revokedAt && !(row.expiresAt && row.expiresAt <= now.toISOString()),
      )
      const keyClients = active.filter((row) => row.kind === 'key')
      const lastCallOf = new Map(lastCalls.map((row) => [row.clientId, row.lastAt]))
      const toolCount = rows.filter((row) => row.enabled).reduce((sum, row) => sum + row.toolCount, 0)
      const last24h = hourly
      const origin = originOf(c)
      return c.json(
        {
          setup: setupOf({
            liveUpstreams: rows.filter((row) => row.status === 'live').length,
            ownerRunAt: firsts.ownerRunAt,
            keyClients: keyClients.length,
            agentCallAt: firsts.agentCallAt,
            globalPins: pins.length,
          }),
          totals: {
            upstreams: rows.length,
            live: rows.filter((row) => row.status === 'live').length,
            failing: rows.filter((row) => row.status === 'failing').length,
            tools: toolCount,
            clients: active.length,
            pendingReviews: pending.length,
          },
          calls: {
            last24h: outcomesOf(last24h),
            last7d: outcomesOf(daily),
            hourly: bucketsOf(hourly, { now, bucket: 'hour', size: 24 }),
            daily: bucketsOf(daily, { now, bucket: 'day', size: 7 }),
          },
          upstreams: rows.map((row) => {
            const today = usage24h.get(row.id)
            return {
              id: row.id,
              title: row.title,
              kind: row.kind,
              status: row.status,
              enabled: row.enabled,
              lastError: row.lastError,
              syncedAt: row.syncedAt,
              toolCount: row.toolCount,
              calls24h: today?.count ?? 0,
              failed24h: today?.failed ?? 0,
              p50Ms: today?.p50Ms ?? null,
            }
          }),
          topTools: topTools.map((row) => ({ name: row.tool, calls7d: Number(row.count) })),
          unanswered: await unansweredSearches({ searches, calls }, ago(7 * DAY_MS), 5),
          findability: await findabilityOf(ago(7 * DAY_MS)),
          nudges: nudgesOf({
            now,
            pendingReviews: pending.length,
            packFlags: (await packFlags({ packs, tools })).length,
            grouping: {
              ready: Boolean(await services.grouping.ready()),
              byRules: (
                await Promise.all(
                  rows
                    .filter((row) => row.kind !== 'composio')
                    .map(async (row) => {
                      const groups = await tools.groupsOf(row.id)
                      return groups.length && groups.every((group) => group.source === 'rules')
                        ? [{ id: row.id, title: row.title, tools: row.toolCount }]
                        : []
                    }),
                )
              ).flat(),
            },
            keyClients: keyClients.map((row) => ({
              id: row.id,
              name: row.name,
              createdAt: row.createdAt,
              lastCallAt: lastCallOf.get(row.id) ?? null,
            })),
            upstreams: rows.map((row) => ({
              id: row.id,
              title: row.title,
              status: row.status,
              lastError: row.lastError,
              createdAt: row.createdAt,
              calls30d: usage30d.get(row.id)?.count ?? 0,
            })),
          }),
          firstAgentCallAt: firsts.agentCallAt,
          _links: linksOf(origin, {
            self: PATH,
            upstreams: '/api/upstreams',
            clients: '/api/clients',
            calls: '/api/calls',
            reviews: '/api/reviews',
            unanswered: '/api/searches/unanswered',
            events: '/api/events',
          }),
        },
        200,
      )
    })

    app.openapi(routes.stats, async (c) => {
      requireOwner(c)
      const { range, via, client, pack: packName } = c.req.valid('query')
      const pack = packName ? await packs.get(packName) : undefined
      if (packName && !pack)
        throw new ProblemError('not_found', { detail: `No pack ${packName}. GET /api/packs lists them.` })
      const clientIds = pack
        ? (await clients.list()).filter((row) => row.packId === pack.id).map((row) => row.id)
        : client
          ? [client]
          : undefined
      const now = new Date()
      const twoWindows = new Date(now.getTime() - 2 * RANGES[range].ms).toISOString()
      const stats = statsOf(await calls.window({ since: twoWindows, via, ...(clientIds ? { clientIds } : {}) }), {
        now,
        range,
      })
      // Searches: counted over both windows, then this window's taken off to leave the one before
      const searchesOf = async (since: string) => {
        const found = await findability({ searches, calls }, since)
        if (!clientIds) return found.overall
        const each = clientIds.map((id) => found.of(id))
        return {
          searches: each.reduce((sum, one) => sum + one.searches, 0),
          found: each.reduce((sum, one) => sum + one.found, 0),
        }
      }
      const [current, both] = await Promise.all([searchesOf(stats.since), searchesOf(stats.previousSince)])
      return c.json(
        {
          range,
          since: stats.since,
          previousSince: stats.previousSince,
          bucket: stats.bucket,
          scope: { client: client ?? null, pack: packName ?? null, via: via ?? null },
          tiles: {
            now: { ...stats.tiles.now, searches: current.searches, found: current.found },
            before: {
              ...stats.tiles.before,
              searches: both.searches - current.searches,
              found: both.found - current.found,
            },
          },
          series: stats.series,
          tools: stats.tools,
          agents: stats.agents,
          upstreams: stats.upstreams,
          unanswered: await unansweredSearches({ searches, calls }, stats.since, 8, clientIds),
          _links: linksOf(originOf(c), { self: STATS_PATH, overview: PATH, calls: '/api/calls' }),
        },
        200,
      )
    })

    const systemOf = async (c: Context) => {
      const pages = await db.all<unknown>(
        sql`select page_count * page_size as bytes from pragma_page_count(), pragma_page_size()`,
      )
      const first = pages[0] as unknown[] | { bytes: number } | undefined
      const bytes = Array.isArray(first) ? Number(first[0]) : Number(first?.bytes ?? 0)
      const dir = join(env.STATE_DIR ?? '.state', 'backups')
      const backups = (() => {
        try {
          return readdirSync(dir)
            .filter((name) => name.endsWith('.sqlite'))
            .map((name) => {
              const stat = statSync(join(dir, name))
              return { file: name, bytes: stat.size, at: stat.mtime.toISOString() }
            })
            .sort((a, b) => b.at.localeCompare(a.at))
        } catch {
          return []
        }
      })()
      return {
        version: VERSION,
        keys: {
          masterKey: (readInstance(env.STATE_DIR ?? '.state').masterKey === env.GATEWAY_MASTER_KEY ? 'file' : 'env') as
            | 'file'
            | 'env',
        },
        build: env.GATEWAY_BUILD ?? null,
        node: process.version,
        startedAt,
        database: { bytes },
        backups,
        jobs: jobs.current?.view() ?? [],
        liveSync: watcher.states(),
        serverName: SERVER_NAME,
        features: {
          meaningSearch: meaning ? (meaning.ready?.() ?? true) : false,
          traces: Boolean(env.GATEWAY_LANGFUSE_PUBLIC_KEY && env.GATEWAY_LANGFUSE_SECRET_KEY),
          access: Boolean(env.ACCESS_TEAM && env.ACCESS_AUD),
          oauth: Boolean(env.OAUTH_SIGNING_KEY),
          alerts: Boolean(env.DISCORD_WEBHOOK_URL),
        },
        publicOrigin,
        _links: linksOf(originOf(c), { self: SYSTEM_PATH, config: '/api/config', overview: PATH }),
      }
    }
    app.openapi(routes.system, async (c) => {
      requireOwner(c)
      return c.json(await systemOf(c), 200)
    })
    app.openapi(routes.runJob, async (c) => {
      requireOwner(c)
      if (!jobs.current)
        throw new ProblemError('conflict', {
          detail: 'This gateway runs without its scheduler (a test or demo process), so there is no job to run.',
        })
      await jobs.current.run(c.req.valid('param').name)
      return c.json(await systemOf(c), 200)
    })
  },
  tools: [],
}
