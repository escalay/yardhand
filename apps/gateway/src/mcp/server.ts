/**
 * What agents see at `/mcp`. The kit's factory builds the meta-tools, resources and prompt over the routes; per
 * request this adds `call_tool` and the client's pinned tools (which return the upstream's own result blocks), and
 * names the upstreams this client may use in the server instructions.
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import {
  type CallToolResult,
  fromJsonSchema,
  type GetPromptResult,
  type InputRequiredResult,
  inputRequired,
  type McpRequestContext,
  type McpServer,
  type ReadResourceResult,
  ResourceTemplate,
  TRACEPARENT_META_KEY,
} from '@modelcontextprotocol/server'
import { z } from 'zod'
import { VIA_HEADER } from '../features/calls/handlers.js'
import { progressSink } from '../features/calls/progress.js'
import type { Principal } from '../features/clients/principals.js'
import { pathWith } from '../kit/index.js'
import { type AgentMcpFactory, type CallApi, mcpServerFactory, mountMcp } from '../kit/mcp/index.js'
import type { Services } from '../services.js'
import { VERSION } from '../version.js'
import { manualSkills } from './skills.js'
import { META_TOOLS, PROMPTS, RESOURCES } from './tools.js'

const INFO = {
  name: 'yardhand',
  title: 'Yardhand',
  version: VERSION,
  description: 'One MCP server in front of many: find any tool behind it by what you want to do, then run it.',
}

export const INSTRUCTIONS = [
  'Yardhand: one MCP server in front of many. You see a few tools here; every other tool is found on demand.',
  '',
  'How to work:',
  '1. search_tools with what you want to do (e.g. "find a quick dinner recipe").',
  '2. describe_tool on the best match to read its full description and input schema.',
  '3. call_tool with that name and arguments matching the schema. A cut result says how to page it with get_result.',
  'Pinned tools are listed directly and can be called as they are. Tools marked [changes things] need write scope.',
  'Tool names are `<upstream>.<tool>`; list_upstreams says how each upstream wants to be used, and the',
  'gateway://upstreams/{id} resource holds one upstream with all its tools.',
  '',
  'Servers marked [manual] wrote down how to use their tools: read it once, before their tools, with',
  'read_resource "gateway://u/<upstream>/manual". Playbooks are their step-by-step ways to do one task: search_tools',
  'suggests them and get_playbook fills one in. Links a tool returns (cookbook://recipes/123) are read with',
  'read_resource, as they are.',
].join('\n')

const META = 'yardhand/call'

/** In-process calls to the routes with the caller's credentials, marked as coming through MCP. */
const viaMcp =
  (app: OpenAPIHono): CallApi =>
  async (call, auth) =>
    app.request(pathWith(call.path, call.query), {
      method: call.method ?? 'GET',
      headers: {
        accept: 'application/json',
        [VIA_HEADER]: 'mcp',
        ...(call.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...((auth?.extra?.headers ?? {}) as Record<string, string>),
      },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    })

type Problem = { detail?: string; title?: string }
type CallResult = {
  id: string
  durationMs: number
  held: { pages: number } | null
  result: CallToolResult
  status: 'ok' | 'tool_error' | 'asked'
  asked: { inputRequests: Record<string, unknown>; requestState: string } | null
}
type Auth = McpRequestContext['authInfo']
/** What a tool handler's context tells the gateway about this request. */
type ToolContext = {
  http?: { authInfo?: Auth }
  mcpReq?: {
    _meta?: Record<string, unknown>
    envelope?: Record<string, unknown>
    inputResponses?: Record<string, unknown>
    requestState?: () => unknown
    notify?: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>
  }
}

const CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'

/** The request's auth with the caller's `_meta.traceparent` as a header, so the call joins the caller's trace. */
const withTrace = (auth: Auth, ctx: ToolContext): Auth => {
  const traceparent = ctx.mcpReq?._meta?.[TRACEPARENT_META_KEY]
  if (typeof traceparent !== 'string') return auth
  const extra = (auth?.extra ?? {}) as Record<string, unknown>
  const headers = (extra.headers ?? {}) as Record<string, string>
  return { ...auth, extra: { ...extra, headers: { ...headers, traceparent } } } as Auth
}

/** Can this client answer a question mid-call? Only a 2026-07-28 client that declares elicitation or sampling. */
const answersQuestions = (ctx: ToolContext) => {
  const capabilities = (ctx.mcpReq?.envelope?.[CAPABILITIES] ?? ctx.mcpReq?._meta?.[CAPABILITIES]) as
    | { elicitation?: unknown; sampling?: unknown }
    | undefined
  return Boolean(capabilities?.elicitation || capabilities?.sampling)
}

/** The answers this request brings to questions a previous round asked, with the state handed out then. */
const answersOf = (ctx: ToolContext) => {
  const inputResponses = ctx.mcpReq?.inputResponses
  const state = ctx.mcpReq?.requestState?.()
  return inputResponses && typeof state === 'string' ? { inputResponses, requestState: state } : undefined
}

/**
 * Runs a tool through POST /api/calls and hands back the upstream's own result, its questions as an input request
 * (the client answers and calls again), or the problem as a tool error. Progress the upstream reports goes on to the
 * client when it asked for it.
 */
/**
 * What an agent reads: the tool's own text when it wrote some, without the typed JSON beside it. Clients show the JSON
 * instead of the text when both come (an upstream's few readable lines became thousands of tokens); scripts get the
 * JSON from REST (`POST /api/calls`), which is untouched. A text that only says "Done" beside real data is no answer:
 * then the JSON stays.
 */
export const readable = (result: CallResult['result']) => {
  const { structuredContent, ...rest } = result
  if (structuredContent === undefined) return rest
  const text = (result.content as { type: string; text?: string }[])
    .map((block) => (block.type === 'text' ? (block.text ?? '').trim() : ''))
    .join('')
  const token = text.length < 80 && JSON.stringify(structuredContent).length > 4 * text.length + 200
  return text && !token ? rest : result
}

const runTool = async (
  callApi: CallApi,
  ctx: ToolContext,
  fallbackAuth: Auth,
  tool: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | InputRequiredResult> => {
  const auth = withTrace(ctx.http?.authInfo ?? fallbackAuth, ctx)
  const token = ctx.mcpReq?._meta?.progressToken as string | number | undefined
  const answers = answersOf(ctx)
  const send = () =>
    callApi(
      {
        method: 'POST',
        path: '/api/calls',
        body: { tool, arguments: args, interactive: answersQuestions(ctx), ...(answers ? { answers } : {}) },
      },
      auth,
    )
  const report =
    token !== undefined && ctx.mcpReq?.notify
      ? (step: { progress: number; total?: number; message?: string }) =>
          void ctx.mcpReq
            ?.notify?.({ method: 'notifications/progress', params: { progressToken: token, ...step } })
            .catch(() => {})
      : null
  const response = report ? await progressSink.run(report, send) : await send()
  const json = (await response.json().catch(() => null)) as CallResult | Problem | null
  if (!response.ok) {
    const problem = (json ?? {}) as Problem
    return {
      isError: true,
      content: [{ type: 'text', text: problem.detail ?? problem.title ?? `The gateway answered ${response.status}.` }],
    }
  }
  const call = json as CallResult
  if (call.status === 'asked' && call.asked)
    return inputRequired({ inputRequests: call.asked.inputRequests as never, requestState: call.asked.requestState })
  return {
    ...readable(call.result),
    _meta: { ...call.result._meta, [META]: { id: call.id, durationMs: call.durationMs, pages: call.held?.pages ?? 1 } },
  }
}

/** A pack key's instructions: the pack's own words, then what it holds. Its tools are listed directly. */
export const packInstructions = (
  pack: NonNullable<Me['pack']>,
  pins: Pin[],
  readOnly: boolean,
  others: Me['packs'] = [],
) =>
  [
    `${pack.title}: ${pack.description}`.trim(),
    '',
    `This connection is the pack ${pack.title}: the tools listed here are all it reaches. Call them as they are;`,
    'search_tools and describe_tool look inside the pack only.',
    ...(others.length
      ? [
          `The same key opens other packs, each its own connection: ${others.map((other) => `${other.title} (${other.mcpUrl})`).join(', ')}.`,
        ]
      : []),
    ...(readOnly ? ['This key is read-only: tools in the pack that change things are left out.'] : []),
    ...(pack.playbooks.length
      ? [
          '',
          `Playbooks (step-by-step ways to do one task, as prompts or with get_playbook): ${pack.playbooks.join(', ')}.`,
        ]
      : []),
    ...(pack.manuals.length
      ? [
          '',
          `Manuals (read once, before the tools, with read_resource): ${pack.manuals.map((name) => `gateway://u/${name.split('.')[0]}/manual`).join(', ')}.`,
        ]
      : []),
    '',
    'Tools:',
    ...pins.map((pin) => `- ${pin.name}: ${pin.description.split(/\n\s*\n/)[0]?.slice(0, 200) ?? ''}`),
  ].join('\n')

/** The instructions plus the upstreams this caller may use, so an agent knows what is here before it searches. */
const instructionsFor = async (callApi: CallApi, auth: Auth, scope: string | undefined) => {
  const response = await callApi({ path: '/api/upstreams' }, auth).catch(() => null)
  const readOnly =
    scope === 'read'
      ? '\n\nThis key is read-only: tools that change things are hidden (search_tools says how many matched).'
      : ''
  if (!response?.ok) return `${INSTRUCTIONS}${readOnly}`
  const { _embedded } = (await response.json()) as {
    _embedded: {
      upstreams: { id: string; title: string; toolCount: number; offers: { manuals: number; playbooks: number } }[]
    }
  }
  const lines = _embedded.upstreams.map(
    (row) =>
      `- ${row.id}: ${row.title} (${row.toolCount} tools${row.offers.playbooks ? `, ${row.offers.playbooks} playbooks` : ''})${row.offers.manuals ? ' [manual]' : ''}`,
  )
  return lines.length
    ? `${INSTRUCTIONS}${readOnly}\n\nConnected for you:\n${lines.join('\n')}`
    : `${INSTRUCTIONS}${readOnly}`
}

type Me = {
  id: string
  name: string
  owner: boolean
  scope: 'read' | 'write'
  upstreams: 'all' | string[]
  resultCap: number
  pins: Pin[]
  pack: { name: string; title: string; description: string; playbooks: string[]; manuals: string[] } | null
  packs: { name: string; title: string; mcpUrl: string; default: boolean }[]
}
type PlaybookCard = {
  name: string
  title: string
  description: string
  offered: boolean
  arguments: { name: string; description: string | null; required: boolean }[]
}
type ManualCard = { name: string; upstream: string; description: string }

/** Problems from a route, as the error an MCP client shows. */
const failed = async (response: Response) => {
  const problem = (await response.json().catch(() => null)) as Problem | null
  return new Error(problem?.detail ?? problem?.title ?? `The gateway answered ${response.status}.`)
}

/** Its playbooks as prompts: the slash commands of hosts like Claude Code (`/mcp__gw__cookbook-plan-a-dinner`). */
const registerPlaybooks = async (server: McpServer, callApi: CallApi, auth: Auth) => {
  const response = await callApi({ path: '/api/playbooks', query: { limit: 200 } }, auth)
  if (!response.ok) return
  const { _embedded } = (await response.json()) as { _embedded: { playbooks: PlaybookCard[] } }
  for (const playbook of _embedded.playbooks.filter((card) => card.offered)) {
    const argsSchema = z.object(
      Object.fromEntries(
        playbook.arguments.map((arg) => {
          const text = arg.description ? z.string().describe(arg.description) : z.string()
          return [arg.name, arg.required ? text : text.optional()]
        }),
      ),
    )
    try {
      server.registerPrompt(
        playbook.name,
        {
          title: playbook.title,
          description: playbook.description,
          ...(playbook.arguments.length ? { argsSchema } : {}),
        } as never,
        (async (args: Record<string, string> = {}, promptCtx: { http?: { authInfo?: Auth } }) => {
          const answer = await callApi(
            {
              path: `/api/playbooks/${encodeURIComponent(playbook.name)}/messages`,
              query: { arguments: JSON.stringify(args) },
            },
            promptCtx?.http?.authInfo ?? auth,
          )
          if (!answer.ok) throw await failed(answer)
          const json = (await answer.json()) as { description: string | null; messages: GetPromptResult['messages'] }
          return { ...(json.description ? { description: json.description } : {}), messages: json.messages }
        }) as never,
      )
    } catch (error) {
      console.warn(`playbook ${playbook.name} skipped: ${error instanceof Error ? error.message : error}`)
    }
  }
}

/** A link through the gateway, as an MCP resource read. */
const readLink = async (callApi: CallApi, auth: Auth, uri: string): Promise<ReadResourceResult> => {
  const answer = await callApi({ path: '/api/resources', query: { uri } }, auth)
  if (!answer.ok) throw await failed(answer)
  const { contents } = (await answer.json()) as {
    contents: { uri: string; mimeType: string | null; text: string | null; blob: string | null }[]
  }
  return {
    contents: contents.map((part) => ({
      uri: part.uri,
      ...(part.mimeType ? { mimeType: part.mimeType } : {}),
      ...(part.text !== null ? { text: part.text } : { blob: part.blob ?? '' }),
    })) as ReadResourceResult['contents'],
  }
}

/** Manuals listed as resources, and every upstream's links behind one template: `gateway://u/{upstream}/{+uri}`. */
const registerLinks = async (server: McpServer, callApi: CallApi, auth: Auth) => {
  server.registerResource(
    'link',
    new ResourceTemplate('gateway://u/{upstream}/{+uri}', { list: undefined }),
    {
      title: 'A link from a server',
      description:
        'What a server’s link holds (gateway://u/cookbook/cookbook://recipes/123), or its manual (gateway://u/cookbook/manual).',
    },
    async (uri, _variables, resourceCtx) => readLink(callApi, resourceCtx.http?.authInfo ?? auth, uri.href),
  )
  const response = await callApi({ path: '/api/manuals' }, auth)
  if (!response.ok) return
  const { _embedded } = (await response.json()) as { _embedded: { manuals: ManualCard[] } }
  const seen = new Set<string>()
  for (const manual of _embedded.manuals) {
    if (seen.has(manual.upstream)) continue
    seen.add(manual.upstream)
    server.registerResource(
      `manual-${manual.upstream}`,
      `gateway://u/${manual.upstream}/manual`,
      { title: `${manual.upstream} manual`, description: manual.description, mimeType: 'text/markdown' },
      async (uri, resourceCtx) => readLink(callApi, resourceCtx.http?.authInfo ?? auth, uri.href),
    )
  }
}

type Pin = {
  name: string
  title: string | null
  description: string
  inputSchema: Record<string, unknown>
  annotations: Record<string, unknown>
}

export const gatewayMcpFactory = (app: OpenAPIHono, services: Services): AgentMcpFactory => {
  const callApi = viaMcp(app)
  const build = (instructions: string) =>
    mcpServerFactory({
      info: { ...INFO, websiteUrl: `${services.publicOrigin}/llms.txt` },
      instructions,
      tools: META_TOOLS,
      resources: RESOURCES,
      prompts: PROMPTS,
      callApi,
    })
  const base = build(INSTRUCTIONS)
  const factory = async (ctx: McpRequestContext) => {
    const auth = ctx.authInfo
    const me = await callApi({ path: '/api/me' }, auth)
    const caller = me.ok ? ((await me.json()) as Me) : null
    const instructions = caller?.pack
      ? packInstructions(
          caller.pack,
          caller.pins,
          caller.scope === 'read',
          caller.packs.filter((other) => other.name !== caller.pack?.name),
        )
      : await instructionsFor(callApi, auth, caller?.scope)
    const server = (await build(instructions)(ctx)) as McpServer
    server.registerTool(
      'call_tool',
      {
        title: 'Run a tool',
        description:
          'Runs any tool behind the gateway by name and returns its own result (its readable text; the typed JSON is on REST `POST /api/calls`). Find it with search_tools and read its schema with describe_tool first.',
        inputSchema: z.object({
          name: z.string().min(3).max(160).describe('The tool name, `<upstream>.<tool>`.'),
          arguments: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Arguments matching the tool’s input schema.'),
        }),
        // It runs whatever tool it is given, which may change things
        annotations: {
          title: 'Run a tool',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      (async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }, toolCtx: ToolContext) =>
        runTool(callApi, toolCtx, auth, name, args ?? {})) as never,
    )
    if (caller) {
      const principal: Principal = {
        id: caller.id,
        name: caller.name,
        owner: caller.owner,
        scope: caller.scope,
        upstreams: caller.upstreams,
        pins: null,
        macTools: false,
        resultCap: caller.resultCap,
        packs: caller.packs.map(({ name, title }) => ({ name, title })),
        pack: caller.pack
          ? {
              id: caller.pack.name,
              name: caller.pack.name,
              title: caller.pack.title,
              description: caller.pack.description,
              // Only manuals and playbooks are read off this one; the routes resolve tools themselves
              tools: new Map(caller.pins.map((pin) => [pin.name, { tool: pin.name, wording: null, fixed: {} }])),
              playbooks: new Set(caller.pack.playbooks),
              manuals: new Set(caller.pack.manuals),
            }
          : null,
      }
      await registerPlaybooks(server, callApi, auth)
      await registerLinks(server, callApi, auth)
      manualSkills(services, principal).attach(server)
      for (const pin of caller.pins) {
        // One upstream schema the SDK can't take must not take /mcp down for this client
        try {
          server.registerTool(
            pin.name,
            // The upstream's own JSON Schema and annotations, served as they are
            {
              title: pin.title ?? pin.name,
              description: pin.description,
              inputSchema: fromJsonSchema(pin.inputSchema as never),
              annotations: pin.annotations,
            } as never,
            (async (args: Record<string, unknown>, toolCtx: ToolContext) =>
              runTool(callApi, toolCtx, auth, pin.name, args)) as never,
          )
        } catch (error) {
          console.warn(`pin ${pin.name} skipped: ${error instanceof Error ? error.message : error}`)
        }
      }
    }
    return server
  }
  return Object.assign(factory, {
    info: base.info,
    tools: base.tools,
    resources: base.resources,
    instructions: base.instructions,
    prompts: base.prompts,
  }) as unknown as AgentMcpFactory
}

export const mountGatewayMcp = (
  app: OpenAPIHono,
  services: Services,
  { allowedHostnames }: { allowedHostnames: string[] },
) => mountMcp(app, { factory: gatewayMcpFactory(app, services), allowedHostnames })
