/** Upstream routes: anyone sees the upstreams they may reach; only the owner adds, changes, syncs or removes them. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'

export const PATH = '/api/upstreams'
export const TAG = 'Upstreams'

const AuthInputSchema = z
  .object({
    type: z.enum(['none', 'bearer', 'header', 'basic', 'oauth']).openapi({
      description:
        '`bearer` sends `Authorization: Bearer <value>`, `header` sends `<header>: <value>`, `basic` takes `user:password`, `oauth` (MCP upstreams) connects with POST /api/upstreams/{id}/connect.',
    }),
    header: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .openapi({ description: 'The header name, for `header` (e.g. `x-api-key`).' }),
    value: z
      .string()
      .min(1)
      .max(8000)
      .optional()
      .openapi({ description: 'The secret. Stored sealed; never returned.' }),
  })
  .openapi('UpstreamAuthInput', { description: 'How the gateway authenticates to the upstream.' })

const HttpEndpointSchema = z
  .object({
    name: z.string().min(1).max(64).openapi({ example: 'set_flag' }),
    method: z.enum(['get', 'post', 'put', 'patch', 'delete']),
    path: z.string().min(1).max(300).openapi({
      description: 'Relative to the upstream url; `{name}` takes an input of that name.',
      example: '/flags',
    }),
    description: z.string().min(1).max(2000).openapi({ description: 'When to use it: the agent chooses by this.' }),
    input: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({ description: 'JSON Schema per input, e.g. `{ "on": { "type": "boolean" } }`.' }),
    body: z.boolean().optional().openapi({ description: 'Send the inputs as a JSON body (default: yes unless GET).' }),
  })
  .openapi('HttpEndpoint', { description: 'One REST endpoint defined by hand.' })
export const HttpConfigSchema = z
  .object({
    spec: z
      .string()
      .max(500)
      .optional()
      .openapi({ description: 'OpenAPI 3.x document, absolute or relative to the url.', example: '/openapi.json' }),
    operations: z
      .array(z.string().max(120))
      .max(500)
      .optional()
      .openapi({ description: 'Only these operations (operationId, any case); all when absent.' }),
    endpoints: z.array(HttpEndpointSchema).max(200).optional(),
  })
  .openapi('HttpConfig', { description: 'For `kind: http`: where the tools come from.' })

export const ComposioConfigSchema = z
  .object({
    mode: z.enum(['personal', 'project']).default('personal').openapi({
      description:
        '`personal`: a personal key (`ck_`, Composio dashboard Settings → Sessions & API Key) as auth header `x-consumer-api-key`; the labelled accounts, through Composio’s hosted MCP. `project`: a project key as auth header `x-api-key`, with `userId`, through the REST API.',
    }),
    toolkits: z
      .array(z.string().regex(/^[a-z0-9_]{1,60}$/))
      .min(1)
      .max(40)
      .openapi({
        description: 'The apps whose tools it lists, by Composio toolkit slug.',
        example: ['gmail', 'googlecalendar'],
      }),
    off: z
      .array(z.string().regex(/^[a-z0-9_]{1,60}$/))
      .max(40)
      .optional()
      .openapi({ description: 'Apps among `toolkits` switched off: their tools are not fetched at all.' }),
    userId: z
      .string()
      .max(200)
      .optional()
      .openapi({ description: 'For `project`: the Composio user that owns the accounts.' }),
    catalogUrl: z
      .string()
      .url()
      .optional()
      .openapi({ description: 'Where Composio’s REST API is (default https://backend.composio.dev).' }),
  })
  .openapi('ComposioConfig', { description: 'For `kind: composio`: how to reach Composio and which apps to list.' })

const KIND_TEXT =
  '`mcp`: an MCP server at url. `http`: a REST API at url, its tools from `http`. `composio`: your Composio apps, its tools from `composio` (url defaults by mode). `sample`: three harmless tools built into the gateway, to try it with (no url or key).'

export const UpstreamSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    kind: z.enum(['mcp', 'http', 'composio', 'sample']),
    url: z.string().nullable().openapi({ description: 'Shown to the owner only.' }),
    http: HttpConfigSchema.nullable().openapi({ description: 'Shown to the owner only, for `kind: http`.' }),
    composio: ComposioConfigSchema.nullable().openapi({
      description: 'Shown to the owner only, for `kind: composio`.',
    }),
    auth: z.enum(['none', 'bearer', 'header', 'basic', 'oauth']).nullable().openapi({
      description: 'How the gateway signs in to it (owner only); the secret itself never leaves the vault.',
    }),
    trust: z.enum(['trusted', 'review']),
    enabled: z.boolean(),
    status: z.enum(['new', 'live', 'failing']),
    toolCount: z.number().int(),
    groups: z.array(z.object({ key: z.string(), title: z.string(), tools: z.number().int() })).openapi({
      description:
        'Its groups with the tools you are listed in each, biggest first: narrow `GET /api/tools` with `upstream` and `group`. Empty for a pack key.',
    }),
    offers: z
      .object({
        manuals: z.number().int(),
        playbooks: z.number().int(),
        links: z.number().int().openapi({ description: 'Resource templates and listed resources.' }),
      })
      .openapi({ description: 'What it offers besides tools, live now.' }),
    playbooks: z.boolean().openapi({ description: 'Its playbooks are offered to agents (the owner’s switch).' }),
    linkProxy: z.boolean().openapi({
      description: 'Links to its own host open through the gateway with its credential (`/u/{id}/r/*`).',
    }),
    instructions: z.string().nullable().openapi({ description: 'How the upstream says it should be used.' }),
    server: z.string().nullable(),
    lastError: z.string().nullable(),
    syncedAt: z.string().nullable(),
    _links: LinksSchema,
  })
  .openapi('Upstream', { description: 'A server the gateway reaches, with its health and how to use it.' })
const SyncSummarySchema = z
  .object({
    added: z.array(z.string()),
    changed: z.array(z.string()),
    pending: z
      .array(z.string())
      .openapi({ description: 'New or changed tools waiting for review (GET /api/reviews).' }),
    removed: z.array(z.string()),
    restored: z.array(z.string()),
    catalog: z
      .object({
        added: z.array(z.string()),
        changed: z.array(z.string()),
        pending: z.array(z.string()),
        removed: z.array(z.string()),
      })
      .openapi({ description: 'Manuals, playbooks and links, by the names agents see.' }),
  })
  .openapi('SyncSummary', { description: 'What a sync changed in the registry.' })
const UpstreamWithSyncSchema = UpstreamSchema.extend({
  sync: SyncSummarySchema.nullable().openapi({
    description: 'The first sync, or null when it failed (see lastError).',
  }),
}).openapi('UpstreamWithSync', { description: 'The new upstream and what its first sync found.' })
export const UpstreamListSchema = z
  .object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ upstreams: z.array(UpstreamSchema) }) })
  .openapi('UpstreamList', { description: 'The upstreams the caller may reach.' })
const UpstreamInputSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
      .openapi({ description: 'Short id; tools become `<id>.<tool>`.', example: 'cookbook' }),
    title: z.string().min(1).max(120).optional(),
    kind: z.enum(['mcp', 'http', 'composio', 'sample']).default('mcp').openapi({ description: KIND_TEXT }),
    url: z.string().url().optional().openapi({
      example: 'https://docs.example.test/mcp',
      description: 'Required, except for `composio` and `sample`.',
    }),
    http: HttpConfigSchema.optional(),
    composio: ComposioConfigSchema.optional(),
    auth: AuthInputSchema,
    trust: z
      .enum(['trusted', 'review'])
      .default('review')
      .openapi({ description: '`trusted`: tool changes go live on sync. `review`: they wait for approval.' }),
    enabled: z.boolean().default(true),
    linkProxy: z.boolean().default(true).openapi({
      description:
        'Open links to its own host through the gateway with its credential. Off for an account-wide API (Composio).',
    }),
  })
  .openapi('UpstreamInput', { description: 'A new upstream. It is synced at once.' })
const UpstreamPatchSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    url: z.string().url().optional(),
    http: HttpConfigSchema.optional(),
    composio: ComposioConfigSchema.optional().openapi({
      description: 'For `kind: composio`: replaces its config and resyncs.',
    }),
    auth: AuthInputSchema.optional(),
    trust: z.enum(['trusted', 'review']).optional(),
    enabled: z.boolean().optional(),
    playbooks: z.boolean().optional().openapi({ description: 'Offer its playbooks to agents.' }),
    linkProxy: z
      .boolean()
      .optional()
      .openapi({ description: 'Open links to its own host through the gateway with its credential.' }),
  })
  .openapi('UpstreamPatch', {
    description: 'Fields to change. A new url or auth drops pooled connections and resyncs.',
  })
const ProbeInputSchema = z
  .object({
    url: z.string().url().openapi({ example: 'https://mcp.notion.com/mcp' }),
    auth: AuthInputSchema.optional().openapi({ description: 'A key to try with, if it asks for one.' }),
  })
  .openapi('ProbeInput', { description: 'A URL to look at before adding it.' })
const ProbeSchema = z
  .object({
    url: z.string(),
    reachable: z.boolean(),
    kind: z
      .enum(['mcp', 'http'])
      .nullable()
      .openapi({ description: 'What answered, or null when nothing usable did.' }),
    auth: z.object({
      needed: z
        .enum(['none', 'key', 'oauth'])
        .openapi({ description: '`oauth`: add it with auth `oauth`, then connect.' }),
      accepted: z.boolean().openapi({ description: 'The tools could be read with what was given.' }),
    }),
    server: z.string().nullable(),
    instructions: z.string().nullable(),
    http: z.object({ spec: z.string() }).nullable().openapi({ description: 'For a REST API: where its spec is.' }),
    suggested: z
      .object({ id: z.string(), title: z.string() })
      .openapi({ description: 'A free id and a title for it.' }),
    toolCount: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Null until it can be read (OAuth not connected yet).' }),
    tools: z.array(
      z
        .object({ name: z.string(), title: z.string().nullable(), summary: z.string(), readOnly: z.boolean() })
        .openapi('ProbedTool', {
          description: 'A tool it would bring, as the server describes it.',
        }),
    ),
    offers: z
      .object({ manuals: z.number().int(), playbooks: z.number().int(), links: z.number().int() })
      .openapi({ description: 'What it would bring besides tools: manuals, playbooks, kinds of link.' }),
    problem: z.string().nullable().openapi({ description: 'What stands in the way, in a sentence, or null.' }),
    _links: LinksSchema,
  })
  .openapi('Probe', { description: 'What a URL is and what adding it would bring. Nothing is saved.' })
const AccountSchema = z
  .object({
    id: z.string().openapi({ description: 'What a call’s `account` takes (and what a pack fixes).' }),
    label: z.string().openapi({ description: 'The name you gave it in Composio, e.g. "Acme Work Email".' }),
    toolkit: z.string(),
    status: z.string().openapi({ description: 'Composio’s status, e.g. ACTIVE or EXPIRED.' }),
    isDefault: z.boolean().openapi({ description: 'Used when a call leaves `account` out.' }),
    email: z.string().nullable(),
  })
  .openapi('UpstreamAccount', { description: 'One account an upstream holds for an app.' })
const AccountListSchema = z
  .object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ accounts: z.array(AccountSchema) }) })
  .openapi('UpstreamAccountList', { description: 'The accounts an upstream holds, by app.' })
const id = z.string().min(1).max(40).openapi({ description: 'The upstream id.' })
const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({
  content: { [HAL_JSON]: { schema } },
  description,
})
const json = <Schema extends z.ZodTypeAny>(schema: Schema) => ({
  required: true,
  content: { 'application/json': { schema } },
})

export const routes = {
  list: createRoute({
    method: 'get',
    path: PATH,
    operationId: 'listUpstreams',
    tags: [TAG],
    summary: 'Upstreams',
    description: 'The upstreams the caller may reach, with their tool counts, health and usage instructions.',
    responses: { 200: ok('Upstreams.', UpstreamListSchema), ...problemResponses(401, 403) },
  }),
  probe: createRoute({
    method: 'post',
    path: `${PATH}/probe`,
    operationId: 'probeUpstream',
    tags: [TAG],
    summary: 'Look before adding',
    description:
      'Works out what a URL is (an MCP server or a REST API with an OpenAPI spec), what sign-in it wants and which tools it would bring, with a suggested id. Saves nothing (owner only).',
    request: { body: json(ProbeInputSchema) },
    responses: { 200: ok('What the URL is.', ProbeSchema), ...problemResponses(400, 401, 403) },
  }),
  get: createRoute({
    method: 'get',
    path: `${PATH}/{id}`,
    operationId: 'getUpstream',
    tags: [TAG],
    summary: 'One upstream',
    description: 'An upstream with its instructions and health.',
    request: { params: z.object({ id }) },
    responses: { 200: ok('The upstream.', UpstreamSchema), ...problemResponses(401, 403, 404) },
  }),
  create: createRoute({
    method: 'post',
    path: PATH,
    operationId: 'createUpstream',
    tags: [TAG],
    summary: 'Add an upstream',
    description:
      'Adds an upstream, seals its credential and syncs its tools at once (owner only). The first sync makes every tool live.',
    request: { body: json(UpstreamInputSchema) },
    responses: {
      201: ok('The upstream and its first sync.', UpstreamWithSyncSchema),
      ...problemResponses(400, 401, 403, 409),
    },
  }),
  update: createRoute({
    method: 'patch',
    path: `${PATH}/{id}`,
    operationId: 'updateUpstream',
    tags: [TAG],
    summary: 'Change an upstream',
    description: 'Changes an upstream; a new url or credential resyncs it (owner only).',
    request: { params: z.object({ id }), body: json(UpstreamPatchSchema) },
    responses: { 200: ok('The upstream.', UpstreamSchema), ...problemResponses(400, 401, 403, 404) },
  }),
  remove: createRoute({
    method: 'delete',
    path: `${PATH}/{id}`,
    operationId: 'deleteUpstream',
    tags: [TAG],
    summary: 'Remove an upstream',
    description: 'Removes the upstream, its tools and its credential (owner only).',
    request: { params: z.object({ id }) },
    responses: { 204: { description: 'Removed.' }, ...problemResponses(401, 403, 404) },
  }),
  accounts: createRoute({
    method: 'get',
    path: `${PATH}/{id}/accounts`,
    operationId: 'listUpstreamAccounts',
    tags: [TAG],
    summary: 'Its accounts',
    description:
      'The accounts a Composio upstream holds for each of its apps, with the labels you gave them: what a call’s `account` input takes and what a pack fixes (owner only).',
    request: { params: z.object({ id }) },
    responses: { 200: ok('Its accounts.', AccountListSchema), ...problemResponses(401, 403, 404, 503) },
  }),
  sync: createRoute({
    method: 'post',
    path: `${PATH}/{id}/sync`,
    operationId: 'syncUpstream',
    tags: [TAG],
    summary: 'Sync an upstream',
    description: 'Reads the upstream’s tools again and reconciles the registry (owner only).',
    request: { params: z.object({ id }) },
    responses: { 200: ok('What changed.', SyncSummarySchema), ...problemResponses(401, 403, 404, 503) },
  }),
}
