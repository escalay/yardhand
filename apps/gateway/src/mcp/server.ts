/**
 * What agents see at `/mcp`. The kit's factory builds the meta-tools, resources and prompt over the routes; per
 * request this adds `call_tool` and the client's pinned tools (which return the upstream's own result blocks), and
 * names the upstreams this client may use in the server instructions. A pack connection has the same shape under the
 * pack's own name: the meta-tools over the pack, and every tool of the pack listed (or only its key's own pins).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
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
import { type Principal, packScopeFrom } from '../features/clients/principals.js'
import { packMcpIcons } from '../features/packs/icon.js'
import { SKILL_DOC } from '../features/packs/skill.js'
import { MODERN_PROTOCOL_VERSION, originOf, pathWith } from '../kit/index.js'
import {
  type AgentMcpFactory,
  type CallApi,
  FORWARDED,
  type McpPrompt,
  type McpServerInfo,
  type McpTool,
  mcpServerFactory,
  mountMcp,
} from '../kit/mcp/index.js'
import type { Services } from '../services.js'
import { VERSION } from '../version.js'
import { manualSkills } from './skills.js'
import { countOf, META_TOOLS, metaToolsFor, OWN_NAMES, PROMPTS, promptsFor, RESOURCES } from './tools.js'

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
    id?: string | number
    _meta?: Record<string, unknown>
    envelope?: Record<string, unknown>
    inputResponses?: Record<string, unknown>
    requestState?: () => unknown
    notify?: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>
  }
}

const CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'

/**
 * The request's auth for one tool call: the caller's `_meta.traceparent` as a header, so the call joins the caller's
 * trace, and the caller's `Idempotency-Key` as `<key>:<call id>`, as the kit sends it, so a retried call runs once and
 * two calls never share a key.
 */
const forCall = (auth: Auth, ctx: ToolContext): Auth => {
  const traceparent = ctx.mcpReq?._meta?.[TRACEPARENT_META_KEY]
  const extra = (auth?.extra ?? {}) as Record<string, unknown>
  const headers = (extra.headers ?? {}) as Record<string, string>
  const key = headers['idempotency-key']
  if (typeof traceparent !== 'string' && !key) return auth
  const forThisCall = {
    ...headers,
    ...(typeof traceparent === 'string' ? { traceparent } : {}),
    ...(key ? { 'idempotency-key': `${key}:${ctx.mcpReq?.id ?? ''}` } : {}),
  }
  return { ...auth, extra: { ...extra, headers: forThisCall } } as Auth
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
  const auth = forCall(ctx.http?.authInfo ?? fallbackAuth, ctx)
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

const ON_DEMAND = [
  '1. search_tools with what you want to do.',
  '2. describe_tool on the best match to read its full description and input schema.',
  '3. call_tool with that name and arguments matching the schema.',
]

/** How a pack connection is worked: every tool of the pack is listed, or only the key's own pins, or none of them. */
const howToWork = (pack: NonNullable<Me['pack']>, pins: Pin[]) =>
  !pack.ownPins
    ? pins.length
      ? [
          'Every tool of this pack is listed here: call one as it is. search_tools finds one by what you want to do,',
          'describe_tool shows its full description and input schema, and call_tool runs any of them by name.',
        ]
      : ['This pack holds no tools this key can use.']
    : [
        pins.length
          ? 'Your pinned tools are listed here: call them as they are. The rest of the pack is found on demand:'
          : 'No tool of this pack is listed here. Each is found on demand:',
        ...ON_DEMAND,
      ]

/**
 * A pack connection's instructions: the pack's own words, its skill to start with, how to work it, then what it
 * holds, the playbooks written for it before those of its connections. `connections` are its
 * upstreams as `GET /api/upstreams` counts them for the pack; `pins` are the tools listed directly; `shadowed` are
 * the pack's names that one of the connection's own tools holds.
 */
export const packInstructions = (
  pack: NonNullable<Me['pack']>,
  {
    pins,
    readOnly,
    others = [],
    connections = [],
    shadowed = [],
  }: { pins: Pin[]; readOnly: boolean; others?: Me['packs']; connections?: string[]; shadowed?: string[] },
) =>
  [
    `${pack.title}: ${pack.description}`.trim(),
    '',
    ...(pack.skill ? [`Start with the skill, read once before the tools: read_resource "${pack.skill}".`, ''] : []),
    ...howToWork(pack, pins),
    ...(shadowed.length
      ? [
          shadowed.length === 1
            ? `Except ${shadowed[0]}: that name is this connection’s own tool here. Run the pack’s tool of that name with call_tool.`
            : `Except ${shadowed.join(', ')}: those names are this connection’s own tools here. Run the pack’s tools of those names with call_tool.`,
        ]
      : []),
    'A cut result says how to page it with get_result. Tools marked [changes things] need write scope.',
    ...(others.length
      ? [
          `The same key opens other packs, each its own connection: ${others.map((other) => `${other.title} (${other.mcpUrl})`).join(', ')}.`,
        ]
      : []),
    ...(readOnly ? ['This key is read-only: tools in the pack that change things are left out.'] : []),
    ...(pack.ownPlaybooks.length + pack.playbooks.length
      ? [
          '',
          `Playbooks (step-by-step ways to do one task, as prompts or with get_playbook): ${[...pack.ownPlaybooks, ...pack.playbooks].join(', ')}.`,
        ]
      : []),
    ...(pack.manuals.length
      ? [
          '',
          `Manuals (read once, before the tools, with read_resource): ${pack.manuals.map((name) => `gateway://u/${name.split('.')[0]}/manual`).join(', ')}.`,
        ]
      : []),
    ...(connections.length ? ['', 'In this pack:', ...connections] : []),
    ...(pins.length
      ? [
          '',
          'Listed here:',
          ...pins.map((pin) => `- ${pin.name}: ${pin.description.split(/\n\s*\n/)[0]?.slice(0, 200) ?? ''}`),
        ]
      : []),
  ].join('\n')

/** One line per upstream this caller may use, as `GET /api/upstreams` counts them for it (a pack key: its pack's). */
const upstreamLines = async (callApi: CallApi, auth: Auth) => {
  const response = await callApi({ path: '/api/upstreams' }, auth).catch(() => null)
  if (!response?.ok) return []
  const { _embedded } = (await response.json()) as {
    _embedded: {
      upstreams: { id: string; title: string; toolCount: number; offers: { manuals: number; playbooks: number } }[]
    }
  }
  return _embedded.upstreams.map(
    (row) =>
      `- ${row.id}: ${row.title} (${countOf(row.toolCount, 'tool')}${row.offers.playbooks ? `, ${countOf(row.offers.playbooks, 'playbook')}` : ''})${row.offers.manuals ? ' [manual]' : ''}`,
  )
}

/** The instructions plus the upstreams this caller may use, so an agent knows what is here before it searches. */
const instructionsFor = (lines: string[], scope: string | undefined) => {
  const readOnly =
    scope === 'read'
      ? '\n\nThis key is read-only: tools that change things are hidden (search_tools says how many matched).'
      : ''
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
  pack: {
    name: string
    title: string
    description: string
    playbooks: string[]
    manuals: string[]
    /** The playbooks written for the pack, and where its skill is read (null without one). */
    ownPlaybooks: string[]
    skill: string | null
    ownPins: boolean
  } | null
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
          const field = arg.required ? text : text.optional()
          // An argument named like what every object has (`constructor`) would read the inherited one when left out
          return [
            arg.name,
            Object.hasOwn(Object.prototype, arg.name)
              ? z.preprocess(
                  (value) => (value === Object.prototype[arg.name as keyof object] ? undefined : value),
                  field,
                )
              : field,
          ]
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

type Served = { info: McpServerInfo; instructions: string; tools: McpTool[]; prompts: McpPrompt[] }

/** The address a request came by, from the forwarded headers `mountMcp` hands its tools. */
const originOfAuth = (auth: Auth) => {
  const headers = (auth?.extra?.headers ?? {}) as Record<string, string>
  return `${headers['x-forwarded-proto'] ?? 'http'}://${headers['x-forwarded-host'] ?? 'localhost'}`
}

/**
 * A pack's name and instructions, or the refusal an ended caller reads, for the kit's own answer to `initialize`,
 * which reads them off the factory and not off a server built for the request.
 */
const packGreeting = new AsyncLocalStorage<Pick<Served, 'info' | 'instructions'>>()

const gatewayMcp = (app: OpenAPIHono, services: Services) => {
  const callApi = viaMcp(app)
  const build = ({ info, instructions, tools, prompts }: Served) =>
    // Typed JSON only beside a declared output schema: clients show it instead of the text when both come
    mcpServerFactory({ info, instructions, tools, resources: RESOURCES, prompts, callApi, structured: 'withOutput' })
  const gateway = {
    info: { ...INFO, websiteUrl: `${services.publicOrigin}/llms.txt` },
    tools: META_TOOLS,
    prompts: PROMPTS,
  }
  /**
   * A pack connection names itself after the pack: its name, its title, the first words of what it is for, and its
   * icon at the address asked by (`inline`: the 96 PNG first, as the kit sends the gateway's own).
   */
  const packServed = async (pack: NonNullable<Me['pack']>, origin: string, inline: boolean) => {
    const row = await services.packs.get(pack.name)
    const icon = row ? await services.packIcons.of(row) : null
    const info: McpServerInfo = {
      name: pack.name,
      title: pack.title,
      version: VERSION,
      description: pack.description.trim().split(/\n\s*\n/)[0] || `The ${pack.title} pack.`,
      websiteUrl: `${services.publicOrigin}/p/${pack.name}/llms.txt`,
    }
    return {
      info: icon ? { ...info, icons: packMcpIcons(info, origin, icon.files, inline) } : info,
      tools: metaToolsFor(pack),
      prompts: promptsFor(pack),
    }
  }
  const base = build({ ...gateway, instructions: INSTRUCTIONS })
  /**
   * What this caller is served: the gateway, or its pack under the pack's own name. A caller the gateway refuses (its
   * access ended) is served the gateway's own tools with the refusal as the instructions; every tool answers it too.
   */
  const servedFor = async (auth: Auth, { inline }: { inline: boolean }) => {
    const me = await callApi({ path: '/api/me' }, auth)
    if (me.status === 403) {
      const problem = (await me.json().catch(() => null)) as Problem | null
      const instructions = problem?.detail ?? INSTRUCTIONS
      return { caller: null, pins: [], pack: null, refused: true, served: { ...gateway, instructions } }
    }
    const caller = me.ok ? ((await me.json()) as Me) : null
    const pack = caller?.pack ?? null
    const connections = await upstreamLines(callApi, auth)
    // A pin under the name of one of the connection's own tools is not listed: that tool keeps the name
    const pins = (caller?.pins ?? []).filter((pin) => !OWN_NAMES.has(pin.name))
    const instructions =
      caller && pack
        ? packInstructions(pack, {
            pins,
            readOnly: caller.scope === 'read',
            others: caller.packs.filter((other) => other.name !== pack.name),
            connections,
            shadowed: caller.pins.filter((pin) => OWN_NAMES.has(pin.name)).map((pin) => pin.name),
          })
        : instructionsFor(connections, caller?.scope)
    return {
      caller,
      pins,
      pack,
      refused: false,
      served: { ...(pack ? await packServed(pack, originOfAuth(auth), inline) : gateway), instructions },
    }
  }
  const factory = async (ctx: McpRequestContext) => {
    const auth = ctx.authInfo
    // As the kit decides for the gateway's own: 2026-07-28 stamps serverInfo on every answer, the inline icon only on discover
    const inline =
      ctx.era !== 'modern' || !ctx.requestInfo || ctx.requestInfo.headers.get('mcp-method') === 'server/discover'
    const { caller, pins, pack, served } = await servedFor(auth, { inline })
    const server = (await build(served)(ctx)) as McpServer
    server.registerTool(
      'call_tool',
      {
        title: 'Run a tool',
        description: `${pack ? `Runs a tool of ${pack.title} by name` : 'Runs any tool behind the gateway by name'} and returns its own result (its readable text; the typed JSON is on REST \`POST /api/calls\`). Find it with search_tools and read its schema with describe_tool first.`,
        inputSchema: z.object({
          name: z
            .string()
            .min(3)
            .max(160)
            .describe(pack ? 'The tool name as search_tools gives it.' : 'The tool name, `<upstream>.<tool>`.'),
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
        // Only manuals, playbooks and the pack's skill are read off this one; the routes resolve tools themselves
        pack: caller.pack
          ? packScopeFrom(
              {
                id: caller.pack.name,
                name: caller.pack.name,
                title: caller.pack.title,
                description: caller.pack.description,
              },
              {
                tools: [],
                variables: [],
                playbooks: caller.pack.playbooks,
                manuals: caller.pack.manuals,
                docs: [
                  ...caller.pack.ownPlaybooks.map((name) => ({ kind: 'playbook' as const, name })),
                  ...(caller.pack.skill ? [{ kind: 'skill' as const, name: SKILL_DOC }] : []),
                ],
              },
            )
          : null,
      }
      await registerPlaybooks(server, callApi, auth)
      await registerLinks(server, callApi, auth)
      manualSkills(services, principal).attach(server)
      for (const pin of pins) {
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
  // Read per request, so a pack connection's greeting is the pack's; everything else is the gateway's
  Object.defineProperties(factory, {
    info: { enumerable: true, get: () => packGreeting.getStore()?.info ?? base.info },
    instructions: { enumerable: true, get: () => packGreeting.getStore()?.instructions ?? base.instructions },
  })
  return {
    factory: Object.assign(factory, {
      tools: base.tools,
      resources: base.resources,
      prompts: base.prompts,
    }) as unknown as AgentMcpFactory,
    servedFor,
  }
}

export const mountGatewayMcp = (
  app: OpenAPIHono,
  services: Services,
  { allowedHostnames }: { allowedHostnames: string[] },
) => {
  const { factory, servedFor } = gatewayMcp(app, services)
  // A 2026-07-28 client that still opens with `initialize` is greeted by the kit from the factory: as the pack, when
  // the caller is served one, and with the refusal when its access ended. Only that one request pays for the look.
  app.use('/mcp', async (c, next) => {
    if (c.req.method !== 'POST' || c.req.header('mcp-protocol-version') !== MODERN_PROTOCOL_VERSION) return next()
    const message = (await c.req.raw
      .clone()
      .json()
      .catch(() => null)) as { method?: string } | null
    if (message?.method !== 'initialize') return next()
    const origin = new URL(originOf(c))
    const forwarded = FORWARDED.flatMap((name) => {
      const value = c.req.header(name)
      return value ? [[name, value]] : []
    })
    const headers = {
      ...Object.fromEntries(forwarded),
      'x-forwarded-proto': origin.protocol.slice(0, -1),
      'x-forwarded-host': origin.host,
    }
    const { pack, refused, served } = await servedFor({ extra: { headers } } as unknown as Auth, { inline: true })
    return pack || refused ? packGreeting.run({ info: served.info, instructions: served.instructions }, next) : next()
  })
  return mountMcp(app, { factory, allowedHostnames })
}
