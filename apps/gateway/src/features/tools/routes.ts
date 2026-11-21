/** Tool routes: search and describe the tools the caller may use; the owner reviews changed third-party tools. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'

export const PATH = '/api/tools'
export const REVIEWS_PATH = '/api/reviews'
export const TAG = 'Tools'

const Json = z.record(z.string(), z.unknown())
export const ToolCardSchema = z
  .object({
    name: z.string().openapi({ example: 'cookbook.research_recipes' }),
    upstream: z.string(),
    title: z.string().nullable(),
    summary: z.string().openapi({ description: 'The first lines of the description; GET the tool for all of it.' }),
    needsWrite: z.boolean().openapi({ description: 'Calling it changes something, so it needs write scope.' }),
    destructive: z.boolean().openapi({
      description: 'It deletes or overwrites something (its upstream’s destructive hint), beyond just changing things.',
    }),
    access: z
      .enum(['read', 'write', 'off'])
      .nullable()
      .openapi({ description: 'The owner’s setting; `off` tools are shown to the owner only and never run.' }),
    group: z
      .object({ key: z.string(), title: z.string() })
      .nullable()
      .openapi({ description: 'The group of its connection it is filed in.' }),
    offBy: z
      .enum(['you', 'group', 'effect'])
      .nullable()
      .openapi({ description: 'Why it is off, when it is: you, its group, or its effect (reads, changes, deletes).' }),
    pinned: z.boolean().openapi({ description: 'Shown directly in this caller’s MCP tool list.' }),
    calls7d: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'Calls in the last 7 days, for the owner (null for other callers).' }),
    _links: LinksSchema,
  })
  .openapi('ToolCard', { description: 'A tool in a list or search result.' })
export const ToolDetailSchema = z
  .object({
    name: z.string(),
    upstream: z.string(),
    title: z.string().nullable(),
    description: z.string(),
    inputSchema: Json,
    outputSchema: Json.nullable(),
    annotations: Json,
    needsWrite: z.boolean(),
    access: z.enum(['read', 'write', 'off']).nullable().openapi({
      description:
        'The owner’s setting, which wins over the upstream’s hints (`off`: switched off for everyone); null follows the hints.',
    }),
    group: z
      .object({ key: z.string(), title: z.string() })
      .nullable()
      .openapi({ description: 'The group of its connection it is filed in.' }),
    offBy: z
      .enum(['you', 'group', 'effect'])
      .nullable()
      .openapi({ description: 'Why it is off, when it is: you, its group, or its effect (reads, changes, deletes).' }),
    upstreamInstructions: z
      .string()
      .nullable()
      .openapi({ description: 'How the upstream says its tools should be used.' }),
    manual: z.string().nullable().openapi({
      description: 'Its upstream’s manual, to read before its tools (read_resource, or GET /api/resources?uri=…).',
      example: 'gateway://u/cookbook/manual',
    }),
    _links: LinksSchema,
  })
  .openapi('ToolDetail', { description: 'A tool with everything needed to call it.' })
export const ToolListSchema = z
  .object({
    count: z.number().int().openapi({
      description:
        'How many tools are returned, as this caller reads them: a pack tool under two names counts twice. 0 when a search matches nothing.',
    }),
    query: z.string().nullable(),
    hiddenForScope: z.number().int().openapi({
      description:
        'Matching tools left out because they change things and this key is read-only, counted as `count` counts them; the owner can grant write scope or mark a tool read-only.',
    }),
    hint: z
      .object({
        pack: z.object({ name: z.string(), title: z.string() }).openapi({ description: 'The pack that was searched.' }),
        covers: z.array(z.string()).openapi({
          description:
            'What the pack’s tools are for, by their groups (a connection’s title where they have none): at most six, most tools first. Empty when the pack holds no tool this key can use.',
          example: ['Job search', 'Inbox'],
        }),
        more: z.number().int().openapi({ description: 'How many more groups `covers` leaves out.' }),
      })
      .nullable()
      .openapi({
        description:
          'For a pack key whose search matched nothing in the whole pack: what the pack covers, to ask again by or to tell the person it can’t be done here. Null otherwise, also when the search was narrowed by `upstream` or `group` or its matches are hidden for scope.',
      }),
    playbooks: z
      .array(
        z.object({
          name: z.string(),
          title: z.string(),
          description: z.string(),
        }),
      )
      .openapi({
        description:
          'When searching: up to three playbooks made for what was asked (get_playbook, or GET /api/playbooks/{name}/messages).',
      }),
    _links: LinksSchema,
    _embedded: z.object({ tools: z.array(ToolCardSchema) }),
  })
  .openapi('ToolList', { description: 'Tools, best match first when searching.' })
const ReviewSideSchema = z
  .object({
    title: z.string().nullable(),
    description: z.string(),
    body: z
      .string()
      .nullable()
      .openapi({ description: 'For manuals, playbooks and links: the text that changed (null for a tool).' }),
    inputSchema: Json.nullable().openapi({ description: 'For a tool (null otherwise).' }),
    outputSchema: Json.nullable(),
    annotations: Json.nullable(),
  })
  .openapi('ReviewSide', { description: 'One version of what is reviewed, as the upstream described it.' })
const ReviewKind = z.enum(['tool', 'manual', 'playbook', 'template', 'resource'])
const ReviewSchema = z
  .object({
    versionId: z.string(),
    kind: ReviewKind,
    name: z.string().openapi({ description: 'As agents see it: a tool, a manual or a playbook name, or a link.' }),
    upstream: z.string(),
    change: z.enum(['new', 'changed']),
    live: ReviewSideSchema.nullable().openapi({ description: 'What is served now (null when new).' }),
    proposed: ReviewSideSchema,
    createdAt: z.string(),
    _links: LinksSchema,
  })
  .openapi('Review', {
    description: 'A new or changed tool, manual, playbook or link from a review upstream, waiting for the owner.',
  })
const ReviewListSchema = z
  .object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ reviews: z.array(ReviewSchema) }) })
  .openapi('ReviewList', { description: 'Pending versions, oldest first.' })
const DecisionSchema = z
  .object({ decision: z.enum(['approve', 'reject']) })
  .openapi('ReviewDecision', { description: '`approve` makes the version live; `reject` keeps the current one.' })
const BatchDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    versionIds: z
      .array(z.string().min(3).max(40))
      .max(500)
      .optional()
      .openapi({ description: 'Only these pending versions.' }),
    upstream: z.string().max(40).optional().openapi({ description: 'Only this upstream’s pending versions.' }),
  })
  .openapi('ReviewBatchDecision', {
    description: 'One decision for many pending versions: those listed, or an upstream’s, or all of them.',
  })
const DecidedSchema = z
  .object({
    versionId: z.string(),
    kind: ReviewKind,
    name: z.string(),
    state: z.enum(['live', 'rejected']),
    _links: LinksSchema,
  })
  .openapi('ReviewResult', { description: 'What the decision did.' })
const DecidedListSchema = z
  .object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ decided: z.array(DecidedSchema) }) })
  .openapi('ReviewResults', { description: 'What each decision did.' })
const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({
  content: { [HAL_JSON]: { schema } },
  description,
})
const name = z.string().min(3).max(160).openapi({ description: 'The tool name, `<upstream>.<tool>`.' })
const AsClient = z.string().max(40).optional().openapi({
  description:
    'Owner only: answer as this client would see it (its reach, scope, pack, pins and wording). With `pack`, or at a pack’s address, as that client in that pack; a client that doesn’t open it is a 409. Not logged.',
})
const AsPack = z.string().max(40).optional().openapi({
  description:
    'Owner only: answer as the keys of this pack are answered (its tools under its names and wording, searched as they are searched). Not logged; the first search this way marks the pack tried (`triedAt`).',
  example: 'design',
})

export const routes = {
  openapi: createRoute({
    method: 'get',
    path: `${PATH}/openapi.json`,
    operationId: 'getToolsOpenApi',
    tags: [TAG],
    summary: 'Tools as OpenAPI',
    description:
      'Every tool this key may use as an OpenAPI 3.1 operation (`POST /api/tools/{name}/calls`, its input schema as the body): generate a typed client from it.',
    responses: {
      200: {
        description: 'An OpenAPI 3.1 document.',
        content: {
          'application/vnd.oai.openapi+json;version=3.1': {
            schema: z.record(z.string(), z.unknown()).openapi('ToolsOpenApi', { description: 'OpenAPI 3.1.' }),
          },
        },
      },
      ...problemResponses(401, 403),
    },
  }),
  list: createRoute({
    method: 'get',
    path: PATH,
    operationId: 'listTools',
    tags: [TAG],
    summary: 'Find tools',
    description:
      'Tools the caller may use. With `q`, a search by words and meaning across every allowed upstream, best match first: only tools that clearly match, so a question that matches nothing answers `count: 0` (a gateway with fewer than 50 tools, or without search by meaning, answers as before: its nearest tools and every keyword hit; so does the owner typing in the app, for its keyword hits). Without `q`, all of them by name.',
    request: {
      query: z.object({
        q: z
          .string()
          .max(200)
          .optional()
          .openapi({ description: 'What you want to do, in words.', example: 'search recipes' }),
        upstream: z.string().max(40).optional().openapi({ description: 'Only this upstream.' }),
        group: z
          .string()
          .max(60)
          .optional()
          .openapi({ description: 'Only this group, by its key or title (with `upstream`).' }),
        as: AsClient,
        pack: AsPack,
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(20)
          .openapi({ description: 'At most this many, counted as `count` counts them (1–5000, default 20).' }),
      }),
    },
    responses: { 200: ok('Tools.', ToolListSchema), ...problemResponses(400, 401, 403, 404, 409) },
  }),
  get: createRoute({
    method: 'get',
    path: `${PATH}/{name}`,
    operationId: 'getTool',
    tags: [TAG],
    summary: 'One tool',
    description: 'A tool with its full description, input schema and annotations: read it before calling the tool.',
    request: {
      params: z.object({ name }),
      query: z.object({
        as: AsClient,
        pack: AsPack,
        view: z.enum(['full', 'brief']).default('full').openapi({
          description:
            '`brief` leaves out the output schema and shortens the upstream instructions, for agents reading it in context.',
        }),
      }),
    },
    responses: { 200: ok('The tool.', ToolDetailSchema), ...problemResponses(400, 401, 403, 404, 409) },
  }),
  setAccess: createRoute({
    method: 'patch',
    path: `${PATH}/{name}`,
    operationId: 'setToolAccess',
    tags: [TAG],
    summary: 'Say whether a tool changes things',
    description:
      'Overrides the upstream’s hints for this tool (owner only): `read` lets read-only clients use it, `write` keeps them out, null follows the hints again. Survives new versions.',
    request: {
      params: z.object({ name }),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z
              .object({ access: z.enum(['read', 'write', 'off']).nullable() })
              .openapi('ToolAccess', { description: 'The owner’s setting.' }),
          },
        },
      },
    },
    responses: { 200: ok('The tool.', ToolDetailSchema), ...problemResponses(400, 401, 403, 404) },
  }),
  reviews: createRoute({
    method: 'get',
    path: REVIEWS_PATH,
    operationId: 'listReviews',
    tags: [TAG],
    summary: 'Pending changes',
    description:
      'New or changed tools, manuals, playbooks and links from review upstreams, each beside what is live now (owner only).',
    responses: { 200: ok('Pending versions.', ReviewListSchema), ...problemResponses(401, 403) },
  }),
  decideAll: createRoute({
    method: 'post',
    path: REVIEWS_PATH,
    operationId: 'decideReviews',
    tags: [TAG],
    summary: 'Approve or reject many',
    description:
      'Approves or rejects every pending version that matches: the ids given, or one upstream’s, or all (owner only). Answers what each became.',
    request: { body: { required: true, content: { 'application/json': { schema: BatchDecisionSchema } } } },
    responses: { 200: ok('The decisions.', DecidedListSchema), ...problemResponses(400, 401, 403) },
  }),
  decide: createRoute({
    method: 'post',
    path: `${REVIEWS_PATH}/{versionId}`,
    operationId: 'decideReview',
    tags: [TAG],
    summary: 'Approve or reject',
    description: 'Approves a pending version (it goes live) or rejects it (the live version stays) (owner only).',
    request: {
      params: z.object({
        versionId: z.string().min(3).max(40).openapi({ description: 'The pending version id, from GET /api/reviews.' }),
      }),
      body: { required: true, content: { 'application/json': { schema: DecisionSchema } } },
    },
    responses: { 200: ok('The decision.', DecidedSchema), ...problemResponses(400, 401, 403, 404, 409) },
  }),
}
