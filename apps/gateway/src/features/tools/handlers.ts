/** Tool handlers: what a caller may see is filtered by its allowlist, its scope and whether the upstream is enabled. */
import { createHash } from 'node:crypto'
import type { RouteHandler } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { VIA_HEADER } from '../calls/handlers.js'
import {
  allows,
  callerOf,
  describe,
  entryOf,
  holds,
  type Principal,
  requireOwner,
  runsTool,
  seenBy,
  shownAs,
} from '../clients/principals.js'
import { fuse } from './meaning.js'

/** Meaning counts a bit more than words: generic words like "app" match too much to lead. */
const MEANING_WEIGHT = [1, 1.5]
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

import type { CatalogContent } from '../catalog/content.js'
import { type PlaybookContent, playbookTitleOf, textOf } from '../catalog/content.js'
import type { CatalogVersionRow } from '../catalog/schema.js'
import { matchesEnough } from '../catalog/search.js'
import { actsAs } from './groups.js'
import { toolsOpenApi } from './openapi.js'
import { isOff, type LiveTool, needsWrite } from './repo.js'
import { PATH, REVIEWS_PATH, type routes } from './routes.js'
import type { VersionRow } from './schema.js'

type Routes = typeof routes

const viaOf = (c: Context) => {
  const door = c.req.header(VIA_HEADER)
  return door === 'mcp' || door === 'app' ? door : 'rest'
}

/** The first paragraph, at most 300 characters: enough to choose a tool by. */
export const summaryOf = (description: string) => {
  const first = description.trim().split(/\n\s*\n/)[0] ?? ''
  return first.length > 300 ? `${first.slice(0, 297)}…` : first
}

export const toolsHandlers = ({
  tools,
  catalog,
  upstreams,
  principals,
  meaning,
  searches,
  clients,
  calls,
  listsChanged,
}: Services) => {
  const principalOf = (c: Context) => principals.require(callerOf(c))
  /** The caller, or for the owner with `?as=`, the client it previews: that client's reach, scope and pack. */
  const viewerOf = async (c: Context, as: string | undefined) => {
    const principal = await principalOf(c)
    if (!as) return { principal, preview: false }
    if (!principal.owner) throw new ProblemError('forbidden', { detail: 'Only the owner can look as another client.' })
    const target = await principals.ofClient(as)
    if (typeof target === 'string') throw new ProblemError('conflict', { detail: target })
    return { principal: target, preview: true }
  }
  /**
   * Tools this principal may see: allowed upstream (and in its pack, for a pack key), upstream enabled, and not a
   * write tool for a read-only client.
   */
  const visibleTo = async (principal: Principal) => {
    const enabled = new Set((await upstreams.list()).filter((row) => row.enabled).map((row) => row.id))
    const seen = seenBy(principal)
    return (tool: LiveTool) => enabled.has(tool.upstreamId) && allows(principal, tool.upstreamId) && seen(tool)
  }
  /** What a list shows besides the tool: pinned for this caller, and use for the owner. */
  const extrasFor = async (principal: Principal) => {
    const pins = new Set(principal.pins ?? (await clients.globalPins()))
    const uses = principal.owner
      ? new Map(
          (await calls.byTool(new Date(Date.now() - WEEK_MS).toISOString())).map((row) => [
            row.tool,
            Number(row.count),
          ]),
        )
      : null
    return {
      pinned: (name: string) => pins.has(name),
      calls7d: (name: string) => (uses ? (uses.get(name) ?? 0) : null),
    }
  }
  type Extras = Awaited<ReturnType<typeof extrasFor>>
  const cardOf = (origin: string, tool: LiveTool, extras: Extras) => ({
    name: tool.name,
    upstream: tool.upstreamId,
    title: tool.title,
    summary: summaryOf(tool.description),
    needsWrite: needsWrite(tool),
    destructive: actsAs(tool) === 'deletes',
    access: tool.access,
    group: tool.group,
    offBy: tool.offBy,
    pinned: extras.pinned(tool.name),
    calls7d: extras.calls7d(tool.name),
    _links: linksOf(origin, {
      self: `${PATH}/${tool.name}`,
      call: `${PATH}/${tool.name}/calls`,
      upstream: `/api/upstreams/${tool.upstreamId}`,
    }),
  })
  const definitionOf = (version: VersionRow) => ({
    title: version.title,
    description: version.description,
    body: null,
    inputSchema: JSON.parse(version.inputSchema) as Record<string, unknown>,
    outputSchema: version.outputSchema ? (JSON.parse(version.outputSchema) as Record<string, unknown>) : null,
    annotations: JSON.parse(version.annotations) as Record<string, unknown>,
  })
  const catalogSideOf = (version: CatalogVersionRow) => ({
    ...textOf(JSON.parse(version.content) as CatalogContent),
    inputSchema: null,
    outputSchema: null,
    annotations: null,
  })
  /** Where a decided item is seen: a tool's page, or its upstream's for the rest. */
  const itemLink = (kind: string, name: string, upstreamId: string) =>
    kind === 'tool' ? `${PATH}/${name}` : `/api/upstreams/${upstreamId}`

  /** Everything waiting for the owner: tool versions and catalog versions, oldest first. */
  const pendingAll = async () => {
    const toolRows = (await tools.pending()).map(({ tool, version }) => ({
      versionId: version.id,
      kind: 'tool' as const,
      name: tool.name,
      upstream: tool.upstreamId,
      createdAt: version.createdAt,
      liveVersion: tool.liveVersion,
      approve: () => tools.makeLive(tool.name, version.id),
      reject: () => tools.setState(version.id, 'rejected'),
      sides: async () => {
        const live = tool.liveVersion ? await tools.version(tool.liveVersion) : undefined
        return { live: live ? definitionOf(live) : null, proposed: definitionOf(version) }
      },
    }))
    const catalogRows = (await catalog.pending()).map(({ item, version }) => ({
      versionId: version.id,
      kind: item.kind,
      name: item.name,
      upstream: item.upstreamId,
      createdAt: version.createdAt,
      liveVersion: item.liveVersion,
      approve: () => catalog.makeLive(item.id, version.id),
      reject: () => catalog.setState(version.id, 'rejected'),
      sides: async () => {
        const live = item.liveVersion ? await catalog.version(item.liveVersion) : undefined
        return { live: live ? catalogSideOf(live) : null, proposed: catalogSideOf(version) }
      },
    }))
    return [...toolRows, ...catalogRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  const openapi: RouteHandler<Routes['openapi']> = async (c) => {
    const principal = await principalOf(c)
    const visible = await visibleTo(principal)
    const live = (await tools.listLive({ upstreams: principal.upstreams, limit: 5000 }))
      .filter((tool) => visible(tool) && !isOff(tool))
      .flatMap((tool) => shownAs(principal, tool))
    const version = createHash('sha256')
      .update(live.map((tool) => tool.versionId).join(','))
      .digest('hex')
      .slice(0, 12)
    const doc = toolsOpenApi({ origin: originOf(c), tools: live, version })
    // Its own media type, not HAL: it is a document for generators, not a resource to browse
    return new Response(JSON.stringify(doc, null, 1), {
      status: 200,
      headers: { 'content-type': 'application/vnd.oai.openapi+json;version=3.1', 'cache-control': 'private, no-cache' },
    }) as never
  }
  /** A group by its key or by its title as lists show it. */
  const inGroup = (tool: LiveTool, group: string) =>
    tool.group?.key === group || tool.group?.title.toLowerCase() === group.toLowerCase()
  const list: RouteHandler<Routes['list']> = async (c) => {
    const { q, upstream, group, limit, as } = c.req.valid('query')
    const { principal, preview } = await viewerOf(c, as)
    const visible = await visibleTo(principal)
    const reachable = await visibleTo({ ...principal, scope: 'write' })
    const inUpstream = (tool: LiveTool) =>
      (!upstream || tool.upstreamId === upstream) && (!group || inGroup(tool, group))
    const scoped = (tool: LiveTool) => visible(tool) && inUpstream(tool)
    const words = q?.trim()
    // Both searches look only where this caller may: the best hundred of everything can hold none of its tools
    const within = words
      ? new Set(
          (await upstreams.list())
            .filter((row) => row.enabled && allows(principal, row.id) && (!upstream || row.id === upstream))
            .map((row) => row.id),
        )
      : new Set<string>()
    const byMeaning = async (asked: string) =>
      meaning
        ? (await meaning.names(asked, 5000).catch(() => []))
            .filter((name) => within.has(name.slice(0, name.indexOf('.'))))
            .slice(0, 100)
        : []
    // Keyword and meaning results fused by rank, then cut to what this caller may see
    const ranked = words
      ? fuse(await Promise.all([tools.searchNames(words, 100, [...within]), byMeaning(words)]), 300, MEANING_WEIGHT)
      : null
    const candidates = ranked
      ? await tools.liveMany(ranked)
      : await tools.listLive({ upstreams: upstream ? [upstream] : principal.upstreams, limit: 5000 })
    const found = candidates.filter(scoped).slice(0, limit)
    // Logged for the owner's "what agents looked for"; a failing log never fails the search
    if (words && !preview)
      await searches
        .record({
          clientId: principal.id,
          clientName: principal.name,
          query: words.slice(0, 200),
          results: found.length,
          tools: found.map((tool) => tool.name),
          via: viaOf(c),
        })
        .catch(() => {})
    // Matches a read-only key can't see, counted so it knows they exist and why
    const hiddenForScope =
      principal.scope === 'write'
        ? 0
        : candidates.filter((tool) => inUpstream(tool) && reachable(tool) && !visible(tool)).length
    const origin = originOf(c)
    const extras = await extrasFor(principal)
    return c.json(
      {
        count: found.length,
        query: q?.trim() || null,
        hiddenForScope,
        playbooks: words ? await playbooksFor(principal, words, upstream) : [],
        _links: linksOf(origin, { self: PATH, openapi: `${PATH}/openapi.json` }),
        _embedded: {
          tools: found.flatMap((tool) => shownAs(principal, tool)).map((tool) => cardOf(origin, tool, extras)),
        },
      },
      200,
    )
  }
  /** Playbooks made for what was asked, offered to this caller: at most three, each matching enough of the words. */
  const playbooksFor = async (principal: Principal, words: string, upstream: string | undefined) => {
    const rows = new Map((await upstreams.list()).map((row) => [row.id, row]))
    const items = (await catalog.liveByIds(await catalog.searchIds(words, 30))).filter((item) => {
      const row = rows.get(item.upstreamId)
      return (
        item.kind === 'playbook' &&
        row?.enabled &&
        (row.playbooks || principal.pack) &&
        allows(principal, item.upstreamId) &&
        holds(principal, item) &&
        (!upstream || item.upstreamId === upstream)
      )
    })
    return items
      .map((item) => ({ item, content: item.content as PlaybookContent }))
      .filter(({ item, content }) => matchesEnough(words, `${item.name} ${content.title ?? ''} ${content.description}`))
      .slice(0, 3)
      .map(({ item, content }) => ({
        name: item.name,
        title: playbookTitleOf(item.upstreamId, content),
        description: summaryOf(content.description),
      }))
  }
  const detailOf = async (origin: string, tool: LiveTool, view: 'full' | 'brief' = 'full') => {
    const upstream = await upstreams.get(tool.upstreamId)
    const manuals = await catalog.listLive({ kinds: ['manual'], upstreams: [tool.upstreamId] })
    const instructions = upstream?.instructions ?? null
    return {
      name: tool.name,
      upstream: tool.upstreamId,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: view === 'brief' ? null : tool.outputSchema,
      annotations: tool.annotations,
      needsWrite: needsWrite(tool),
      access: tool.access,
      group: tool.group,
      offBy: tool.offBy,
      upstreamInstructions:
        view === 'brief' && instructions && instructions.length > 1200
          ? `${instructions.slice(0, 1199)}…`
          : instructions,
      manual: manuals.length ? `gateway://u/${tool.upstreamId}/manual` : null,
      _links: linksOf(origin, {
        self: `${PATH}/${tool.name}`,
        call: `${PATH}/${tool.name}/calls`,
        upstream: `/api/upstreams/${tool.upstreamId}`,
      }),
    }
  }
  const get: RouteHandler<Routes['get']> = async (c) => {
    const { principal } = await viewerOf(c, c.req.valid('query').as)
    const { name } = c.req.valid('param')
    // A pack key asks by the pack's name for the tool
    const entry = entryOf(principal, name)
    const tool = entry ? await tools.live(entry.tool) : undefined
    if (!tool || !(await visibleTo(principal))(tool))
      throw new ProblemError('not_found', {
        detail: `No tool ${name} for this client: search_tools (MCP) or GET ${PATH}?q=<what you want to do> finds the ones you may use.`,
      })
    return c.json(await detailOf(originOf(c), describe(principal, tool, name), c.req.valid('query').view), 200)
  }
  const setAccess: RouteHandler<Routes['setAccess']> = async (c) => {
    requireOwner(c)
    const { name } = c.req.valid('param')
    if (!(await tools.live(name)))
      throw new ProblemError('not_found', { detail: `No live tool ${name}. GET ${PATH} lists them.` })
    await tools.setAccess(name, c.req.valid('json').access)
    listsChanged({ tools: true })
    const tool = await tools.live(name)
    return c.json(await detailOf(originOf(c), tool!), 200)
  }
  const reviews: RouteHandler<Routes['reviews']> = async (c) => {
    requireOwner(c)
    const origin = originOf(c)
    const items = await Promise.all(
      (await pendingAll()).map(async (row) => ({
        versionId: row.versionId,
        kind: row.kind,
        name: row.name,
        upstream: row.upstream,
        change: row.liveVersion ? ('changed' as const) : ('new' as const),
        ...(await row.sides()),
        createdAt: row.createdAt,
        _links: linksOf(origin, {
          self: `${REVIEWS_PATH}/${row.versionId}`,
          item: itemLink(row.kind, row.name, row.upstream),
        }),
      })),
    )
    return c.json(
      { count: items.length, _links: linksOf(origin, { self: REVIEWS_PATH }), _embedded: { reviews: items } },
      200,
    )
  }
  const decidedOf = (origin: string, row: Awaited<ReturnType<typeof pendingAll>>[number], approve: boolean) => ({
    versionId: row.versionId,
    kind: row.kind,
    name: row.name,
    state: approve ? ('live' as const) : ('rejected' as const),
    _links: linksOf(origin, { item: itemLink(row.kind, row.name, row.upstream), reviews: REVIEWS_PATH }),
  })
  const decide: RouteHandler<Routes['decide']> = async (c) => {
    requireOwner(c)
    const { versionId } = c.req.valid('param')
    const { decision } = c.req.valid('json')
    const row = (await pendingAll()).find((pending) => pending.versionId === versionId)
    if (!row) {
      const state = (await tools.version(versionId))?.state ?? (await catalog.version(versionId))?.state
      throw state
        ? new ProblemError('conflict', { detail: `Version ${versionId} is ${state}, not pending.` })
        : new ProblemError('not_found', { detail: `No version ${versionId}. GET ${REVIEWS_PATH} lists pending ones.` })
    }
    await (decision === 'approve' ? row.approve() : row.reject())
    if (decision === 'approve') listsChanged()
    return c.json(decidedOf(originOf(c), row, decision === 'approve'), 200)
  }
  const decideAll: RouteHandler<Routes['decideAll']> = async (c) => {
    requireOwner(c)
    const { decision, versionIds, upstream } = c.req.valid('json')
    const wanted = versionIds ? new Set(versionIds) : null
    const chosen = (await pendingAll()).filter(
      (row) => (!wanted || wanted.has(row.versionId)) && (!upstream || row.upstream === upstream),
    )
    for (const row of chosen) await (decision === 'approve' ? row.approve() : row.reject())
    if (decision === 'approve' && chosen.length) listsChanged()
    const origin = originOf(c)
    const decided = chosen.map((row) => decidedOf(origin, row, decision === 'approve'))
    return c.json(
      { count: decided.length, _links: linksOf(origin, { self: REVIEWS_PATH }), _embedded: { decided } },
      200,
    )
  }
  return { openapi, list, get, setAccess, reviews, decide, decideAll }
}
