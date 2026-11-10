/** Client routes (owner only, except `/api/me`): make keys, set what each client reaches, pin tools. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'

export const PATH = '/api/clients'
export const PINS_PATH = '/api/pins'
export const ME_PATH = '/api/me'
export const TAG = 'Clients'

const Upstreams = z.union([z.literal('all'), z.array(z.string().min(1).max(64))]).openapi({
  description: '`all`, or the ids of the upstreams this client may reach.',
  example: ['cookbook', 'composio'],
})
const Pins = z
  .array(z.string().min(1).max(160))
  .max(40)
  .nullable()
  .openapi({
    description: 'Tool names shown directly in MCP, or null to use the global default.',
    example: ['cookbook.research_recipes'],
  })

export const ClientSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(['key', 'oauth']),
    scope: z.enum(['read', 'write']),
    upstreams: Upstreams,
    pins: Pins,
    macTools: z.boolean(),
    resultCap: z.number().int(),
    pack: z.string().nullable().openapi({
      description:
        'The key’s default pack (plain /mcp and REST serve it), or null for a key that reaches its allowlist.',
    }),
    packs: z.array(z.string()).openapi({
      description: 'Every pack the key opens, the default first; each is its own connection at /mcp/p/<name>.',
    }),
    expiresAt: z.string().nullable().openapi({ description: 'When the key stops working, or null for never.' }),
    createdAt: z.string(),
    revokedAt: z.string().nullable(),
    usage: z
      .object({
        calls7d: z.number().int().openapi({ description: 'Calls in the last 7 days.' }),
        lastCallAt: z.string().nullable().openapi({ description: 'Its newest call in the log (90 days), or null.' }),
        searches7d: z.number().int().openapi({ description: 'Its tool searches in the last 7 days.' }),
        found7d: z.number().int().openapi({
          description: 'Of those, the ones followed by a call to a tool it found: it found what it needed.',
        }),
      })
      .openapi('ClientUsage', { description: 'How much the client is used.' }),
    _links: LinksSchema,
  })
  .openapi('Client', { description: 'Who may call the gateway, what it reaches and what it may change.' })
const CreatedClientSchema = ClientSchema.extend({
  key: z.string().openapi({ description: 'The API key. Shown once: store it now.' }),
}).openapi('CreatedClient', { description: 'A new client with its key, shown this once.' })
const ClientListSchema = z
  .object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ clients: z.array(ClientSchema) }) })
  .openapi('ClientList', { description: 'Every client, oldest first.' })
const clientFields = {
  name: z.string().min(1).max(80).openapi({ example: 'invoice-script' }),
  scope: z
    .enum(['read', 'write'])
    .default('read')
    .openapi({ description: '`write` lets it call tools that change things.' }),
  upstreams: Upstreams,
  pins: Pins.optional(),
  macTools: z.boolean().optional().openapi({ description: 'May it call `mac-*` laptop tools (default false).' }),
  resultCap: z
    .number()
    .int()
    .min(1000)
    .max(500_000)
    .optional()
    .openapi({ description: 'MCP result cap in tokens (default 25000).' }),
}
const ClientInputSchema = z.object(clientFields).openapi('ClientInput', { description: 'A new API-key client.' })
const ClientPatchSchema = ClientInputSchema.partial()
  .extend({
    packs: z.array(z.string().min(1).max(60)).min(1).max(20).optional().openapi({
      description: 'For a pack key: the packs it opens from now on (replaces the list).',
    }),
    pack: z.string().min(1).max(60).optional().openapi({
      description: 'For a pack key: its default pack, one of the packs it opens.',
    }),
  })
  .openapi('ClientPatch', { description: 'Fields to change.' })
export const KEY_LIFETIMES = ['8h', '1d', '7d', 'never'] as const
const ClientCreateSchema = z
  .object({
    ...clientFields,
    upstreams: Upstreams.optional().openapi({
      description: '`all`, or the upstream ids it may reach. Required unless `pack` is given: a pack decides it.',
    }),
    pack: z.string().min(1).max(60).optional().openapi({
      description:
        'Lock the key to this pack (its name): it sees and runs only what the pack holds. With `packs`, the default among them.',
      example: 'design',
    }),
    packs: z
      .array(z.string().min(1).max(60))
      .min(1)
      .max(20)
      .optional()
      .openapi({
        description:
          'Lock the key to these packs: each is its own connection at /mcp/p/<name>, and `pack` (else the first) is the default.',
        example: ['acme', 'support'],
      }),
    expiresIn: z
      .enum(KEY_LIFETIMES)
      .optional()
      .openapi({ description: 'How long the key works: 8 hours, a day, a week, or until revoked (the default).' }),
  })
  .openapi('ClientCreate', { description: 'A new API-key client, optionally locked to a pack and expiring.' })
const SurfaceSchema = z
  .object({
    id: z.enum(['claude-code', 'cursor', 'codex', 'claude-ai', 'curl', 'typescript']),
    title: z.string(),
    where: z.string().openapi({ description: 'Where the snippet goes.' }),
    format: z.enum(['shell', 'json', 'toml', 'text', 'typescript']),
    snippet: z.string().openapi({ description: 'Paste-ready, with `<YOUR_KEY>` where the key goes.' }),
    note: z.string().nullable(),
  })
  .openapi('SetupSurface', { description: 'How to connect one kind of agent or script.' })
const SetupSchema = z
  .object({
    client: z.string(),
    mcpUrl: z.string(),
    apiUrl: z.string(),
    keyPlaceholder: z.string().openapi({ description: 'What stands in for the key in every snippet.' }),
    surfaces: z.array(SurfaceSchema),
    _links: LinksSchema,
  })
  .openapi('ClientSetup', {
    description: 'Paste-ready setup for every place this client can run. Never holds the key.',
  })
const GlobalPinsSchema = z
  .object({ tools: z.array(z.string().min(1).max(160)).max(40), _links: LinksSchema })
  .openapi('GlobalPins', { description: 'Tools every client without its own pins sees directly in MCP.' })
const GlobalPinsInputSchema = z
  .object({ tools: z.array(z.string().min(1).max(160)).max(40) })
  .openapi('GlobalPinsInput', { description: 'The new global pins, in order.' })
export const PinnedToolSchema = z
  .object({
    name: z.string(),
    title: z.string().nullable(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
    annotations: z.record(z.string(), z.unknown()),
  })
  .openapi('PinnedTool', { description: 'A pinned tool with what MCP needs to list it.' })
const MeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    owner: z.boolean(),
    scope: z.enum(['read', 'write']),
    upstreams: Upstreams,
    pins: z.array(PinnedToolSchema),
    resultCap: z.number().int(),
    pack: z
      .object({
        name: z.string(),
        title: z.string(),
        description: z.string(),
        playbooks: z.array(z.string()),
        manuals: z.array(z.string()),
      })
      .nullable()
      .openapi({
        description:
          'The pack this request is locked to (its address names it, else the key’s default): its pins are the pack’s tools, in its wording.',
      }),
    packs: z
      .array(
        z.object({
          name: z.string(),
          title: z.string(),
          mcpUrl: z.string().openapi({ description: 'Where to connect to this pack alone.' }),
          default: z.boolean().openapi({ description: 'Served at plain /mcp and to REST without x-gateway-pack.' }),
        }),
      )
      .openapi({ description: 'Every pack this key opens, the default first; empty for a key without packs.' }),
    _links: LinksSchema,
  })
  .openapi('Me', { description: 'The calling client: what it may reach and its pinned tools.' })
const id = z.string().min(1).max(40).openapi({ description: 'The client id (`cl_…`).' })
const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({
  content: { [HAL_JSON]: { schema } },
  description,
})
const json = <Schema extends z.ZodTypeAny>(schema: Schema) => ({
  required: true,
  content: { 'application/json': { schema } },
})

export const routes = {
  me: createRoute({
    method: 'get',
    path: ME_PATH,
    operationId: 'getMe',
    tags: [TAG],
    summary: 'Who am I',
    description: 'The calling client: its scope, the upstreams it reaches and its pinned tools with their schemas.',
    responses: { 200: ok('The caller.', MeSchema), ...problemResponses(401, 403) },
  }),
  list: createRoute({
    method: 'get',
    path: PATH,
    operationId: 'listClients',
    tags: [TAG],
    summary: 'Clients',
    description: 'Every client (owner only).',
    responses: { 200: ok('Clients.', ClientListSchema), ...problemResponses(401, 403) },
  }),
  get: createRoute({
    method: 'get',
    path: `${PATH}/{id}`,
    operationId: 'getClient',
    tags: [TAG],
    summary: 'One client',
    description: 'A client with its allowlist and pins (owner only).',
    request: { params: z.object({ id }) },
    responses: { 200: ok('The client.', ClientSchema), ...problemResponses(401, 403, 404) },
  }),
  create: createRoute({
    method: 'post',
    path: PATH,
    operationId: 'createClient',
    tags: [TAG],
    summary: 'Make a client',
    description: 'A new API-key client. Answers 201 with the key, shown this once (owner only).',
    request: { body: json(ClientCreateSchema) },
    responses: { 201: ok('The new client and its key.', CreatedClientSchema), ...problemResponses(400, 401, 403) },
  }),
  update: createRoute({
    method: 'patch',
    path: `${PATH}/{id}`,
    operationId: 'updateClient',
    tags: [TAG],
    summary: 'Change a client',
    description: 'Changes a client’s name, scope, upstreams, pins, result cap or laptop-tool access (owner only).',
    request: { params: z.object({ id }), body: json(ClientPatchSchema) },
    responses: { 200: ok('The client.', ClientSchema), ...problemResponses(400, 401, 403, 404) },
  }),
  revoke: createRoute({
    method: 'delete',
    path: `${PATH}/{id}`,
    operationId: 'revokeClient',
    tags: [TAG],
    summary: 'Revoke a client',
    description: 'Revokes the client: its key stops working at once. The record stays for the call log (owner only).',
    request: { params: z.object({ id }) },
    responses: { 204: { description: 'Revoked.' }, ...problemResponses(401, 403, 404) },
  }),
  setup: createRoute({
    method: 'get',
    path: `${PATH}/{id}/setup`,
    operationId: 'getClientSetup',
    tags: [TAG],
    summary: 'How to connect it',
    description:
      'Paste-ready setup for Claude Code, Cursor, Codex, claude.ai, curl and TypeScript, with `<YOUR_KEY>` where the key goes: the key itself is shown only once, when the client is made (owner only).',
    request: { params: z.object({ id }) },
    responses: { 200: ok('The setup.', SetupSchema), ...problemResponses(401, 403, 404) },
  }),
  getPins: createRoute({
    method: 'get',
    path: PINS_PATH,
    operationId: 'getGlobalPins',
    tags: [TAG],
    summary: 'Global pins',
    description: 'The tools every client without its own pins sees directly in MCP (owner only).',
    responses: { 200: ok('The global pins.', GlobalPinsSchema), ...problemResponses(401, 403) },
  }),
  setPins: createRoute({
    method: 'put',
    path: PINS_PATH,
    operationId: 'setGlobalPins',
    tags: [TAG],
    summary: 'Set global pins',
    description: 'Replaces the global pins. Unknown tool names are refused (owner only).',
    request: { body: json(GlobalPinsInputSchema) },
    responses: { 200: ok('The global pins.', GlobalPinsSchema), ...problemResponses(400, 401, 403) },
  }),
}
