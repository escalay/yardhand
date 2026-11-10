/**
 * The gateway from a script: find a tool, read it, run it, read the log. Plain fetch, no MCP. Problems come back as
 * `GatewayError` carrying the RFC 9457 body, so a script can read `detail` and `errors`.
 *
 * @example
 * const gateway = createGateway({ url: 'https://yardhand.example.test', key: process.env.YARDHAND_KEY! })
 * const [tool] = await gateway.tools.search('find a recipe')
 * const result = await gateway.call('cookbook.search_recipes', { q: 'soup' })
 * console.log(textOf(result))
 */
import type { ToolArgs, ToolName } from './tools.gen.js'

export type Problem = {
  type?: string
  code?: string
  title: string
  status: number
  detail?: string
  errors?: { in?: string; path: string; message: string }[]
}

/** A problem answer from the gateway, as an Error. */
export class GatewayError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title)
    this.name = 'GatewayError'
  }
}

export type ToolCard = { name: string; upstream: string; title: string | null; summary: string; needsWrite: boolean }
export type ToolDetail = ToolCard & {
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown> | null
  annotations: Record<string, unknown>
  upstreamInstructions: string | null
}
export type ContentBlock = { type: string; text?: string; [key: string]: unknown }
export type CallResult<Structured = unknown> = {
  id: string
  tool: string
  status: 'ok' | 'tool_error'
  durationMs: number
  result: { content: ContentBlock[]; structuredContent?: Structured; isError?: boolean }
}
export type CallRecord = {
  id: string
  client: string
  tool: string
  upstream: string | null
  via: 'rest' | 'mcp' | 'passthrough'
  status: 'ok' | 'tool_error' | 'refused' | 'failed'
  error: string | null
  durationMs: number
  createdAt: string
}

/** The text blocks of a result, joined: what most tools mean by their answer. */
export const textOf = (call: Pick<CallResult, 'result'>) =>
  call.result.content
    .flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')

export const createGateway = ({
  key,
  url,
  fetch: fetchImpl = globalThis.fetch,
}: {
  /** A Yardhand client key, or an OAuth access token. */
  key: string
  /** Your instance, e.g. https://yardhand.example.test. */
  url: string
  fetch?: typeof fetch
}) => {
  const request = async <T>(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ) => {
    const target = new URL(path, url)
    for (const [name, value] of Object.entries(init.query ?? {}))
      if (value !== undefined) target.searchParams.set(name, String(value))
    const response = await fetchImpl(target, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const json = (await response.json().catch(() => null)) as unknown
    if (!response.ok)
      throw new GatewayError((json as Problem | null) ?? { title: response.statusText, status: response.status })
    return json as T
  }

  /** Runs a tool. Known tool names get typed arguments (`pnpm gen` refreshes them from the gateway). */
  const call = <Name extends ToolName | (string & {})>(
    tool: Name,
    args: Name extends ToolName ? ToolArgs[Name] : Record<string, unknown>,
  ) => request<CallResult>('/api/calls', { method: 'POST', body: { tool, arguments: args } })

  return {
    call,
    tools: {
      /** Tools by what you want to do, best match first. */
      search: async (q: string, options: { upstream?: string; limit?: number } = {}) =>
        (await request<{ _embedded: { tools: ToolCard[] } }>('/api/tools', { query: { q, ...options } }))._embedded
          .tools,
      list: async (options: { upstream?: string; limit?: number } = {}) =>
        (await request<{ _embedded: { tools: ToolCard[] } }>('/api/tools', { query: options }))._embedded.tools,
      get: (name: string) => request<ToolDetail>(`/api/tools/${encodeURIComponent(name)}`),
    },
    calls: {
      list: async (options: { tool?: string; limit?: number } = {}) =>
        (await request<{ _embedded: { calls: CallRecord[] } }>('/api/calls', { query: options }))._embedded.calls,
      get: (id: string) => request<CallRecord>(`/api/calls/${encodeURIComponent(id)}`),
    },
  }
}

export type Gateway = ReturnType<typeof createGateway>
