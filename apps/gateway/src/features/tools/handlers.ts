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
  OWNER,
  type Principal,
  requireOwner,
  seenBy,
  shownAs,
} from '../clients/principals.js'
import { fuse, KEYWORD_MIN_Z } from './meaning.js'

/** Meaning counts a bit more than words: generic words like "app" match too much to lead. */
const MEANING_WEIGHT = [1, 1.5]
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

import type { CatalogContent } from '../catalog/content.js'
import { type PlaybookContent, playbookTitleOf, textOf } from '../catalog/content.js'
import type { CatalogVersionRow } from '../catalog/schema.js'
import { matchesEnough } from '../catalog/search.js'
import { actsAs, coversOf } from './groups.js'
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
  /**
   * What a search finds among the tools `mayMatch` allows, best first: a tool that stands out for the question among
   * every tool, or carries its words and is near enough in meaning (or has no vector yet to be scored by). A question
   * that matches nothing finds nothing.
   * Where there is no bar (a small catalog, no search by meaning): the nearest tools and every keyword hit. Where
   * search by meaning fails: every keyword hit. Names are ranked first and only the ranked tools are loaded, so a
   * search costs the same however many tools the caller reaches. `own` is a pack key's tools, for what the pack covers.
   * `typed` is the owner filtering in the app, on half-typed words and connection ids: every keyword hit counts.
   */
  const searchFor = async (
    principal: Principal,
    words: string,
    upstream: string | undefined,
    mayMatch: (tool: LiveTool) => boolean,
    typed: boolean,
  ) => {
    const within = (await upstreams.list())
      .filter((row) => row.enabled && allows(principal, row.id) && (!upstream || row.id === upstream))
      .map((row) => row.id)
    const reach = new Set(within)
    // A pack's tools are ranked among themselves: the best hundred of their connections can hold none of them
    const own = principal.pack
      ? (await tools.liveMany([...new Set([...principal.pack.tools.values()].map((entry) => entry.tool))])).filter(
          mayMatch,
        )
      : null
    const packed = own && new Set(own.map((tool) => tool.name))
    const inReach = (name: string) => (packed ? packed.has(name) : reach.has(name.slice(0, name.indexOf('.'))))
    const hits = await tools.searchNames(words, 100, within, packed ? [...packed] : undefined)
    const barred = async () => {
      if (!meaning) return null
      const stood = await meaning.standouts(words, { limit: 100, keep: inReach })
      if (!stood || typed) return stood && [hits, stood]
      // The question is embedded once: the second look reads it from the embedder's cache
      const near = await meaning.standouts(words, {
        limit: 100,
        keep: (name) => hits.includes(name),
        minZ: KEYWORD_MIN_Z,
      })
      // A hit with no vector yet (synced or approved since the last refresh) can't be scored: it is kept
      return near && [hits.filter((name) => near.includes(name) || !meaning.has(name)), stood]
    }
    const nearest = async () =>
      meaning ? (await meaning.names(words, 5000).catch(() => [])).filter(inReach).slice(0, 100) : []
    // A question that could not be embedded is not sent again for its nearest tools: the words answer alone
    const lists = (await barred().catch(() => [hits])) ?? [hits, await nearest()]
    // Keyword and meaning results fused by rank, then cut to what this search may show
    const found = (await tools.liveMany(fuse(lists, 300, MEANING_WEIGHT))).filter(mayMatch)
    return { found, own: own ?? [] }
  }
  const list: RouteHandler<Routes['list']> = async (c) => {
    const { q, upstream, group, limit, as } = c.req.valid('query')
    const { principal, preview } = await viewerOf(c, as)
    const visible = await visibleTo(principal)
    const reachable = await visibleTo({ ...principal, scope: 'write' })
    const inUpstream = (tool: LiveTool) =>
      (!upstream || tool.upstreamId === upstream) && (!group || inGroup(tool, group))
    const scoped = (tool: LiveTool) => visible(tool) && inUpstream(tool)
    const words = q?.trim()
    // Searched as a write key would be listed, so a read-only key can be told what its scope hides
    const searched = words
      ? await searchFor(
          principal,
          words,
          upstream,
          (tool) => reachable(tool) && inUpstream(tool),
          // Looking as a key, the owner is searched as that key: `principal` is then the key's
          principal.owner && viaOf(c) === 'app',
        )
      : null
    const candidates = searched
      ? searched.found
      : await tools.listLive({ upstreams: upstream ? [upstream] : principal.upstreams, limit: 5000 })
    // A pack shows a tool once per name it gives it: `limit` and `count` are of those
    const shown = candidates
      .filter(scoped)
      .flatMap((tool) => shownAs(principal, tool).map((as) => ({ tool: tool.name, as })))
      .slice(0, limit)
    // Logged for the owner's "what agents looked for"; a failing log never fails the search
    if (words && !preview)
      await searches
        .record({
          clientId: principal.id,
          clientName: principal.name,
          query: words.slice(0, 200),
          results: shown.length,
          tools: [...new Set(shown.map(({ tool }) => tool))],
          via: viaOf(c),
        })
        .catch(() => {})
    // Matches a read-only key can't see, counted as it would read them, so it knows they exist and why
    const hiddenForScope =
      principal.scope === 'write'
        ? 0
        : candidates
            .filter((tool) => inUpstream(tool) && reachable(tool) && !visible(tool))
            .flatMap((tool) => shownAs(principal, tool)).length
    // Only when nothing in the whole pack matched: a narrowed search, or one whose matches are hidden, says so itself
    const hint =
      searched && principal.pack && !searched.found.length && !upstream && !group
        ? {
            pack: { name: principal.pack.name, title: principal.pack.title },
            ...(await coveredBy(searched.own.filter(visible))),
          }
        : null
    const origin = originOf(c)
    const extras = await extrasFor(principal)
    return c.json(
      {
        count: shown.length,
        query: q?.trim() || null,
        hiddenForScope,
        hint,
        playbooks: words ? await playbooksFor(principal, words, upstream) : [],
        _links: linksOf(origin, { self: PATH, openapi: `${PATH}/openapi.json` }),
        _embedded: { tools: shown.map(({ as }) => cardOf(origin, as, extras)) },
      },
      200,
    )
  }
  /** What these tools cover, by their groups, with each connection under its title. */
  const coveredBy = async (listed: LiveTool[]) => {
    const titles = new Map((await upstreams.list()).map((row) => [row.id, row.title]))
    return coversOf(listed, (id) => titles.get(id) ?? id)
  }
  /**
   * Playbooks made for what was asked, offered to this caller: at most three, each matching enough of the words. They
   * are searched among the ones it may read, so better matches it can't read never push its own off the page.
   */
  const playbooksFor = async (principal: Principal, words: string, upstream: string | undefined) => {
    const offering = (await upstreams.list())
      .filter(
        (row) =>
          row.enabled &&
          (row.playbooks || principal.pack) &&
          allows(principal, row.id) &&
          (!upstream || row.id === upstream),
      )
      .map((row) => row.id)
    const ids = await catalog.searchIds(words, 30, {
      kind: 'playbook',
      upstreams: offering,
      names: principal.pack ? [...principal.pack.playbooks] : undefined,
    })
    return (await catalog.liveByIds(ids))
      .filter((item) => holds(principal, item))
      .map((item) => ({ item, content: item.content as PlaybookContent }))
      .filter(({ item, content }) => matchesEnough(words, `${item.name} ${content.title ?? ''} ${content.description}`))
      .slice(0, 3)
      .map(({ item, content }) => ({
        name: item.name,
        title: playbookTitleOf(item.upstreamId, content),
        description: summaryOf(content.description),
      }))
  }
  const detailOf = async (origin: string, tool: LiveTool, principal: Principal, view: 'full' | 'brief' = 'full') => {
    const upstream = await upstreams.get(tool.upstreamId)
    // Only a manual this caller may read: a pack key is pointed at one its pack holds
    const manuals = (await catalog.listLive({ kinds: ['manual'], upstreams: [tool.upstreamId] })).filter((item) =>
      holds(principal, item),
    )
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
    return c.json(
      await detailOf(originOf(c), describe(principal, tool, name), principal, c.req.valid('query').view),
      200,
    )
  }
  const setAccess: RouteHandler<Routes['setAccess']> = async (c) => {
    requireOwner(c)
    const { name } = c.req.valid('param')
    if (!(await tools.live(name)))
      throw new ProblemError('not_found', { detail: `No live tool ${name}. GET ${PATH} lists them.` })
    await tools.setAccess(name, c.req.valid('json').access)
    listsChanged({ tools: true })
    const tool = await tools.live(name)
    return c.json(await detailOf(originOf(c), tool!, OWNER), 200)
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
  /** After an approval: agents list again, and an approved tool is embedded so search by meaning finds it. */
  const approved = (rows: { kind: string }[]) => {
    if (rows.length) listsChanged()
    if (rows.some((row) => row.kind === 'tool')) void meaning?.refresh()
  }
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
    if (decision === 'approve') approved([row])
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
    if (decision === 'approve') approved(chosen)
    const origin = originOf(c)
    const decided = chosen.map((row) => decidedOf(origin, row, decision === 'approve'))
    return c.json(
      { count: decided.length, _links: linksOf(origin, { self: REVIEWS_PATH }), _embedded: { decided } },
      200,
    )
  }
  return { openapi, list, get, setAccess, reviews, decide, decideAll }
}
