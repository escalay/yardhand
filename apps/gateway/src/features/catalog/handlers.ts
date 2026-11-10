/**
 * Catalog handlers. A caller sees what the upstreams it may use offer, while they are switched on; playbooks only
 * while their upstream offers them. The owner sees everything.
 */
import type { RouteHandler } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { VIA_HEADER } from '../calls/handlers.js'
import { allows, callerOf, holds, type Principal } from '../clients/principals.js'
import type { UpstreamRow } from '../upstreams/schema.js'
import { type ManualContent, type PlaybookContent, playbookTitleOf } from './content.js'
import type { LiveItem } from './repo.js'
import { LINKS_PATH, MANUALS_PATH, PLAYBOOKS_PATH, RESOURCES_PATH, type routes } from './routes.js'

type Routes = typeof routes

const viaOf = (c: Context) => {
  const door = c.req.header(VIA_HEADER)
  return door === 'mcp' || door === 'app' ? door : 'rest'
}

export const catalogHandlers = ({ catalog, upstreams, principals, reads, calls }: Services) => {
  const principalOf = (c: Context) => principals.require(callerOf(c))
  /** The upstreams this caller may read the catalog of, by id. */
  const reachable = async (principal: Principal) =>
    new Map(
      (await upstreams.list())
        .filter((row) => allows(principal, row.id) && (principal.owner || row.enabled))
        .map((row) => [row.id, row]),
    )
  const offered = (row: UpstreamRow | undefined) => Boolean(row?.enabled && row.playbooks)
  /** Offered to this caller: its upstream offers playbooks, or the caller's pack holds this one. */
  const offeredTo = (principal: Principal, item: LiveItem, row: UpstreamRow | undefined) =>
    holds(principal, item) && (principal.owner || offered(row) || Boolean(principal.pack && row?.enabled))

  const playbookOf = (origin: string, item: LiveItem, row: UpstreamRow, principal: Principal) => {
    const content = item.content as PlaybookContent
    return {
      name: item.name,
      upstream: item.upstreamId,
      prompt: content.prompt,
      title: playbookTitleOf(row.id, content),
      description: content.description,
      arguments: content.arguments,
      offered: principal.pack ? offeredTo(principal, item, row) : offered(row),
      _links: linksOf(origin, {
        self: `${PLAYBOOKS_PATH}/${item.name}`,
        upstream: `/api/upstreams/${item.upstreamId}`,
      }),
    }
  }

  const manualCardOf = (origin: string, item: LiveItem) => {
    const content = item.content as ManualContent
    return {
      name: item.name,
      upstream: item.upstreamId,
      skill: content.skill,
      description: content.description,
      files: [
        'SKILL.md',
        ...Object.keys(content.files)
          .filter((path) => path !== 'SKILL.md')
          .sort(),
      ],
      _links: linksOf(origin, { self: `${MANUALS_PATH}/${item.name}`, upstream: `/api/upstreams/${item.upstreamId}` }),
    }
  }

  const playbooks: RouteHandler<Routes['playbooks']> = async (c) => {
    const principal = await principalOf(c)
    const { q, upstream, limit } = c.req.valid('query')
    const rows = await reachable(principal)
    const visible = (item: LiveItem) =>
      rows.has(item.upstreamId) &&
      (!upstream || item.upstreamId === upstream) &&
      offeredTo(principal, item, rows.get(item.upstreamId))
    const found = q?.trim()
      ? (await catalog.liveByIds(await catalog.searchIds(q, 200))).filter((item) => item.kind === 'playbook')
      : await catalog.listLive({ kinds: ['playbook'], upstreams: upstream ? [upstream] : 'all' })
    const origin = originOf(c)
    const items = found
      .filter(visible)
      .slice(0, limit)
      .flatMap((item) => {
        const row = rows.get(item.upstreamId)
        return row ? [playbookOf(origin, item, row, principal)] : []
      })
    return c.json(
      { count: items.length, _links: linksOf(origin, { self: PLAYBOOKS_PATH }), _embedded: { playbooks: items } },
      200,
    )
  }
  const playbook: RouteHandler<Routes['playbook']> = async (c) => {
    const principal = await principalOf(c)
    const { name } = c.req.valid('param')
    const item = await catalog.live('playbook', name)
    const row = item ? (await reachable(principal)).get(item.upstreamId) : undefined
    if (!item || !row || !offeredTo(principal, item, row))
      throw new ProblemError('not_found', {
        detail: `No playbook ${name} for this client. GET ${PLAYBOOKS_PATH}?q=<what you want to do> finds yours.`,
      })
    return c.json(playbookOf(originOf(c), item, row, principal), 200)
  }
  const manuals: RouteHandler<Routes['manuals']> = async (c) => {
    const principal = await principalOf(c)
    const { upstream } = c.req.valid('query')
    const rows = await reachable(principal)
    const origin = originOf(c)
    const items = (await catalog.listLive({ kinds: ['manual'], upstreams: upstream ? [upstream] : 'all' }))
      .filter((item) => rows.has(item.upstreamId) && holds(principal, item))
      .map((item) => manualCardOf(origin, item))
    return c.json(
      { count: items.length, _links: linksOf(origin, { self: MANUALS_PATH }), _embedded: { manuals: items } },
      200,
    )
  }
  const manual: RouteHandler<Routes['manual']> = async (c) => {
    const principal = await principalOf(c)
    const { name } = c.req.valid('param')
    const read = await reads.manual({ principal, via: viaOf(c) }, name)
    const original = (read.item.content as ManualContent).files['SKILL.md'] ?? ''
    return c.json(
      {
        ...manualCardOf(originOf(c), read.item),
        note: read.note,
        text: read.files['SKILL.md'] ?? '',
        original: principal.owner ? original : null,
        references: Object.fromEntries(Object.entries(read.files).filter(([path]) => path !== 'SKILL.md')),
      },
      200,
    )
  }
  const messages: RouteHandler<Routes['messages']> = async (c) => {
    const principal = await principalOf(c)
    const { name } = c.req.valid('param')
    const { arguments: raw } = c.req.valid('query')
    let args: Record<string, string> = {}
    if (raw)
      try {
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
        args = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]))
      } catch {
        throw new ProblemError('bad_request', {
          detail: 'arguments is a JSON object of strings, e.g. {"task":"a dinner for six"}.',
        })
      }
    const { id, item, result } = await reads.playbook({ principal, via: viaOf(c) }, name, args)
    return c.json(
      {
        name: item.name,
        callId: id,
        description: result.description ?? null,
        messages: result.messages,
        _links: linksOf(originOf(c), { playbook: `${PLAYBOOKS_PATH}/${item.name}`, call: `/api/calls/${id}` }),
      },
      200,
    )
  }
  const resource: RouteHandler<Routes['resource']> = async (c) => {
    const principal = await principalOf(c)
    const { uri, upstream } = c.req.valid('query')
    const read = await reads.link({ principal, via: viaOf(c) }, uri, upstream)
    const parts = read.result.contents.map((part) => ({
      uri: part.uri,
      mimeType: part.mimeType ?? null,
      text: part.text ?? null,
      blob: part.blob ?? null,
    }))
    // Over the cap (MCP only), like a tool's result: the text is held and comes a page at a time
    const capChars = principal.resultCap * 4
    const text = parts.flatMap((part) => part.text ?? []).join('\n\n')
    const cut = viaOf(c) === 'mcp' && text.length > capChars ? await calls.hold(read.id, text, capChars) : 0
    const contents = cut
      ? [
          {
            uri,
            mimeType: 'text/plain',
            text: `${text.slice(0, capChars)}\n\n[Cut at about ${principal.resultCap} tokens: page 1 of ${cut}. For more, call get_result with call_id "${read.id}" and page 2. Kept for one hour.]`,
            blob: null,
          },
        ]
      : parts
    return c.json(
      {
        uri,
        upstream: read.upstream,
        callId: read.id,
        contents,
        _links: linksOf(originOf(c), {
          self: `${RESOURCES_PATH}?uri=${encodeURIComponent(uri)}`,
          call: `/api/calls/${read.id}`,
        }),
      },
      200,
    )
  }
  const links: RouteHandler<Routes['links']> = async (c) => {
    const principal = await principalOf(c)
    const { upstream } = c.req.valid('query')
    const rows = await reachable(principal)
    const origin = originOf(c)
    const items = (
      await catalog.listLive({ kinds: ['template', 'resource'], upstreams: upstream ? [upstream] : 'all' })
    )
      .filter((item) => rows.has(item.upstreamId))
      .map((item) => {
        const content = item.content as Extract<LiveItem['content'], { kind: 'template' | 'resource' }>
        return {
          upstream: item.upstreamId,
          kind: content.kind,
          uri: item.remoteName,
          title: content.title,
          description: content.description,
          mimeType: content.mimeType,
          _links: linksOf(origin, { upstream: `/api/upstreams/${item.upstreamId}` }),
        }
      })
    return c.json(
      { count: items.length, _links: linksOf(origin, { self: LINKS_PATH }), _embedded: { links: items } },
      200,
    )
  }
  return { playbooks, playbook, messages, manuals, manual, links, resource }
}
