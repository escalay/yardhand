/** Call handlers: every run goes through the pipeline; the log shows a client only its own calls. */
import type { RouteHandler } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { z } from 'zod'
import type { ToolResult } from '../../adapters/index.js'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import { decodeCursor, pageOf } from '../../kit/pagination/index.js'
import type { Services } from '../../services.js'
import { callerOf, type Principal, requireOwner } from '../clients/principals.js'
import { progressSink } from './progress.js'
import { PATH, type routes } from './routes.js'
import type { CallRow } from './schema.js'
import { traceUrlOf } from './traces.js'

type Routes = typeof routes

/** MCP tools reach the routes in-process and say so in this header: the log tells the doors apart, and only MCP is capped. */
export const VIA_HEADER = 'x-gateway-via'
const CHARS_PER_TOKEN = 4

type Block = {
  type?: string
  text?: string
  mimeType?: string
  uri?: string
  name?: string
  resource?: { uri?: string; text?: string }
}

/** A result as plain text, for paging: text as it is, other blocks named, typed JSON when there is no text. */
export const flatten = (result: ToolResult) => {
  const blocks = (result.content as Block[]).map((block) => {
    if (block.type === 'text') return block.text ?? ''
    if (block.type === 'resource_link') return `${block.name ?? 'link'}: ${block.uri ?? ''}`
    if (block.type === 'resource') return block.resource?.text ?? `[resource ${block.resource?.uri ?? ''}]`
    return `[${block.type ?? 'block'}${block.mimeType ? ` ${block.mimeType}` : ''}: get the full result over REST]`
  })
  const text = blocks.join('\n')
  return text.trim() || result.structuredContent === undefined
    ? text
    : JSON.stringify(result.structuredContent, null, 1)
}

/** One CSV cell: quoted when it holds a comma, quote or line break; a leading = + - @ is defused for spreadsheets. */
export const csvCell = (value: string | number) => {
  const text = String(value)
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

export const callsHandlers = ({ pipeline, principals, calls, events, clients, packs, traces }: Services) => {
  const principalOf = (c: Context) => principals.require(callerOf(c))
  /** Over the cap (MCP only): hold the whole result and send page 1 with how to get the rest. */
  const capped = async (principal: Principal, id: string, result: ToolResult) => {
    const capChars = principal.resultCap * CHARS_PER_TOKEN
    if (JSON.stringify(result).length <= capChars) return { result, held: null }
    const text = flatten(result)
    // The text fits, only the typed copy beside it doesn't: send the text whole, nothing to page
    if (text.length <= capChars)
      return { result: { content: [{ type: 'text', text }], ...(result.isError ? { isError: true } : {}) }, held: null }
    const pages = await calls.hold(id, text, capChars)
    const first = await calls.heldPage(id, 1)
    const note = `\n\n[Cut at about ${principal.resultCap} tokens: page 1 of ${pages}. For more, call get_result with call_id "${id}" and page 2. Kept for one hour.]`
    return {
      result: {
        content: [{ type: 'text', text: `${first?.text ?? ''}${note}` }],
        ...(result.isError ? { isError: true } : {}),
      },
      held: { pages, expiresAt: first?.expiresAt ?? '' },
    }
  }
  const run = async (
    c: Context,
    tool: string,
    args: Record<string, unknown>,
    asking: { interactive?: boolean; answers?: { inputResponses: Record<string, unknown>; requestState: string } } = {},
  ) => {
    const principal = await principalOf(c)
    const door = c.req.header(VIA_HEADER)
    // `app` marks the owner trying a tool in the browser app, so agents' calls stay apart from it
    const via = door === 'mcp' ? 'mcp' : door === 'app' && principal.owner ? 'app' : 'rest'
    const progress = progressSink.getStore()
    const outcome = await pipeline({
      principal,
      toolName: tool,
      args,
      via,
      origin: originOf(c),
      interactive: asking.interactive ?? false,
      ...(asking.answers ? { answers: asking.answers } : {}),
      onProgress: (step) => {
        progress?.(step)
        events.emit({ type: 'progress', data: { client: principal.name, clientId: principal.id, tool, ...step } })
      },
    })
    const { result, held } =
      via === 'mcp' ? await capped(principal, outcome.id, outcome.result) : { result: outcome.result, held: null }
    return {
      id: outcome.id,
      tool: outcome.tool,
      status:
        outcome.status === 'asked'
          ? ('asked' as const)
          : outcome.status === 'tool_error'
            ? ('tool_error' as const)
            : ('ok' as const),
      asked: outcome.asked ?? null,
      durationMs: outcome.durationMs,
      result,
      held,
      _links: linksOf(originOf(c), {
        self: `${PATH}/${outcome.id}`,
        tool: `/api/tools/${outcome.tool}`,
        ...(held ? { more: `${PATH}/${outcome.id}/result?page=2` } : {}),
      }),
    }
  }
  type Filters = {
    tool?: string
    client?: string
    upstream?: string
    status?: string
    via?: CallRow['via']
    kind?: string
    since?: string
    until?: string
    pack?: string
  }
  /** The query as a repo filter: a client sees only its own calls; `pack` means the calls of that pack's keys. */
  const filterOf = async (principal: Principal, query: Filters) => {
    const pack = principal.owner && query.pack ? await packs.get(query.pack) : undefined
    if (principal.owner && query.pack && !pack)
      throw new ProblemError('not_found', { detail: `No pack ${query.pack}. GET /api/packs lists them.` })
    const clientIds = pack ? await clients.idsOfPack(pack.id) : undefined
    return {
      clientId: principal.owner ? query.client : principal.id,
      ...(clientIds ? { clientIds } : {}),
      tool: query.tool,
      upstreamId: query.upstream,
      status: query.status?.split(',') as CallRow['status'][] | undefined,
      via: query.via,
      kind: query.kind?.split(',') as CallRow['kind'][] | undefined,
      since: query.since,
      until: query.until,
    }
  }
  const tracesUrlFor = async (principal: Principal) => (principal.owner && traces ? await traces.tracesUrl() : null)
  const recordOf = (origin: string, row: CallRow, tracesUrl: string | null = null) => ({
    id: row.id,
    client: row.clientName,
    clientId: row.clientId,
    tool: row.tool,
    upstream: row.upstreamId,
    kind: row.kind,
    via: row.via,
    status: row.status,
    error: row.error,
    durationMs: row.durationMs,
    resultBytes: row.resultBytes,
    createdAt: row.createdAt,
    traceUrl: traceUrlOf(tracesUrl, row),
    _links: linksOf(origin, { self: `${PATH}/${row.id}`, tool: `/api/tools/${row.tool}` }),
  })
  const ownCall = async (principal: Principal, id: string) => {
    const row = await calls.get(id)
    if (!row || (!principal.owner && row.clientId !== principal.id))
      throw new ProblemError('not_found', { detail: `No call ${id} for this client. GET ${PATH} lists yours.` })
    return row
  }

  const call: RouteHandler<Routes['call']> = async (c) => {
    const { tool, arguments: args, interactive, answers } = c.req.valid('json')
    return c.json(await run(c, tool, args, { interactive, ...(answers ? { answers } : {}) }), 200)
  }
  const callNamed: RouteHandler<Routes['callNamed']> = async (c) =>
    c.json(await run(c, c.req.valid('param').name, c.req.valid('json')), 200)
  const list: RouteHandler<Routes['list']> = async (c) => {
    const principal = await principalOf(c)
    const query = c.req.valid('query')
    const after = decodeCursor(query.cursor, z.object({ createdAt: z.string(), id: z.string() }))
    const tracesUrl = await tracesUrlFor(principal)
    const rows = await calls.page({
      ...(await filterOf(principal, query)),
      after,
      limit: query.limit + 1,
    })
    const items = rows.slice(0, query.limit)
    const last = items.at(-1)
    const origin = originOf(c)
    return c.json(
      pageOf({
        origin,
        path: PATH,
        query,
        name: 'calls',
        items: items.map((row) => recordOf(origin, row, tracesUrl)),
        next: rows.length > query.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
      }),
      200,
    )
  }
  const get: RouteHandler<Routes['get']> = async (c) => {
    const principal = await principalOf(c)
    const row = await ownCall(principal, c.req.valid('param').id)
    return c.json(recordOf(originOf(c), row, await tracesUrlFor(principal)), 200)
  }
  const exportCsv: RouteHandler<Routes['export']> = async (c) => {
    requireOwner(c)
    const principal = await principalOf(c)
    const rows = await calls.page({ ...(await filterOf(principal, c.req.valid('query'))), limit: 10_000 })
    const header = [
      'created_at',
      'client',
      'tool',
      'kind',
      'upstream',
      'via',
      'status',
      'duration_ms',
      'result_bytes',
      'error',
      'id',
    ]
    const lines = rows.map((row) =>
      [
        row.createdAt,
        row.clientName,
        row.tool,
        row.kind,
        row.upstreamId ?? '',
        row.via,
        row.status,
        row.durationMs,
        row.resultBytes,
        row.error ?? '',
        row.id,
      ]
        .map(csvCell)
        .join(','),
    )
    return new Response([header.join(','), ...lines].join('\n'), {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="calls-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    }) as never
  }
  const result: RouteHandler<Routes['result']> = async (c) => {
    const { id } = c.req.valid('param')
    await ownCall(await principalOf(c), id)
    const { page } = c.req.valid('query')
    const held = await calls.heldPage(id, page)
    if (!held)
      throw new ProblemError('not_found', {
        detail: `No held result for ${id}: it was small enough to send whole, or its hour is up. Run the tool again.`,
      })
    if (page > held.pages) throw new ProblemError('not_found', { detail: `Call ${id} has ${held.pages} pages.` })
    return c.json(
      {
        callId: id,
        ...held,
        _links: linksOf(originOf(c), {
          self: `${PATH}/${id}/result?page=${page}`,
          call: `${PATH}/${id}`,
          ...(page < held.pages ? { next: `${PATH}/${id}/result?page=${page + 1}` } : {}),
        }),
      },
      200,
    )
  }
  const payload: RouteHandler<Routes['payload']> = async (c) => {
    requireOwner(c)
    const { id } = c.req.valid('param')
    const kept = await calls.payload(id)
    if (!kept)
      throw new ProblemError('not_found', { detail: `No payload for ${id}: unknown call, or older than 30 days.` })
    return c.json(
      { callId: id, ...kept, _links: linksOf(originOf(c), { self: `${PATH}/${id}/payload`, call: `${PATH}/${id}` }) },
      200,
    )
  }
  return { call, callNamed, list, exportCsv, get, result, payload }
}
