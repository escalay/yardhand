/** Call routes: run a tool, and read the call log (the owner sees every call, a client its own). */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'
import { cursorQuery, limitQuery, pageSchema } from '../../kit/pagination/index.js'

export const PATH = '/api/calls'
export const TAG = 'Calls'
const STATUSES = /^(ok|tool_error|refused|failed|asked)(,(ok|tool_error|refused|failed|asked))*$/

const Args = z.record(z.string(), z.unknown()).openapi({
  description: 'The tool’s arguments, as its input schema describes.',
  example: { q: 'quick dinner' },
})
const ResultSchema = z
  .object({
    content: z.array(z.unknown()).openapi({ description: 'MCP content blocks (text, image, resource links).' }),
    structuredContent: z
      .unknown()
      .optional()
      .openapi({ description: 'Typed JSON, when the tool declares an output schema.' }),
    isError: z.boolean().optional().openapi({ description: 'The tool ran and reported an error.' }),
  })
  .openapi('ToolResult', { description: 'What the tool returned, unchanged.' })
const AskedSchema = z
  .object({
    inputRequests: z.record(z.string(), z.unknown()).openapi({
      description:
        'What the upstream asks, by key: MCP input requests (`elicitation/create` with a message and a schema, or a URL to open; `sampling/createMessage`).',
    }),
    requestState: z
      .string()
      .openapi({ description: 'Send it back, unchanged, with the answers (good for 10 minutes).' }),
  })
  .openapi('Asked', { description: 'Questions an upstream asks mid-call.' })
const AnswersSchema = z
  .object({
    inputResponses: z.record(z.string(), z.unknown()).openapi({
      description:
        'One answer per question key: for a question `{"action":"accept","content":{…}}`, `{"action":"decline"}` or `{"action":"cancel"}`.',
    }),
    requestState: z.string().openapi({ description: 'As the previous answer gave it.' }),
  })
  .openapi('Answers', { description: 'Answers to the questions a call asked, to go on with the same call.' })
const CallResultSchema = z
  .object({
    id: z.string(),
    tool: z.string(),
    status: z.enum(['ok', 'tool_error', 'asked']).openapi({
      description:
        '`asked`: the upstream asks something first (see `asked`); call again with the same tool, arguments and `answers`.',
    }),
    asked: AskedSchema.nullable(),
    durationMs: z.number().int(),
    result: ResultSchema,
    held: z.object({ pages: z.number().int(), expiresAt: z.string() }).nullable().openapi({
      description: 'Set when the result was over the client’s MCP cap: `result` holds page 1, `_links.more` the rest.',
    }),
    _links: LinksSchema,
  })
  .openapi('CallResult', { description: 'A finished call and the tool’s result.' })
const CallPayloadSchema = z
  .object({
    callId: z.string(),
    arguments: z.unknown(),
    result: z.unknown().optional(),
    error: z.string().optional(),
    asked: z.unknown().optional().openapi({ description: 'What the upstream asked, for a call that ended `asked`.' }),
    answers: z.unknown().optional().openapi({ description: 'The answers this call went on with.' }),
    _links: LinksSchema,
  })
  .openapi('CallPayload', { description: 'A call’s arguments and result, as they were.' })
export const HeldPageSchema = z
  .object({
    callId: z.string(),
    page: z.number().int(),
    pages: z.number().int(),
    text: z.string(),
    expiresAt: z.string(),
    _links: LinksSchema,
  })
  .openapi('HeldPage', { description: 'One page of a result too big to send at once.' })
const CallRecordSchema = z
  .object({
    id: z.string(),
    client: z.string(),
    clientId: z.string().openapi({ description: 'The client’s id (`owner` for the owner).' }),
    tool: z.string().openapi({ description: 'The tool, or the manual, playbook or link of a read.' }),
    kind: z.enum(['tool', 'manual', 'playbook', 'link']).openapi({
      description: '`tool`: a tool ran. `manual`, `playbook`, `link`: one was read, with the upstream’s credential.',
    }),
    upstream: z.string().nullable(),
    via: z
      .enum(['rest', 'mcp', 'passthrough', 'app'])
      .openapi({ description: 'The door it came in by; `app` is the owner trying a tool in /app.' }),
    status: z.enum(['ok', 'tool_error', 'refused', 'failed', 'asked']).openapi({
      description:
        '`tool_error`: the tool ran and said no. `refused`: the gateway said no. `failed`: the upstream did not answer. `asked`: the upstream asked the caller something mid-call.',
    }),
    error: z.string().nullable(),
    durationMs: z.number().int(),
    resultBytes: z.number().int(),
    createdAt: z.string(),
    traceUrl: z.string().nullable().openapi({
      description: 'Owner only: where its trace opens in Langfuse (inside the caller’s trace when it sent one).',
    }),
    _links: LinksSchema,
  })
  .openapi('CallRecord', { description: 'One call in the log.' })
const CallPageSchema = pageSchema(
  'CallPage',
  'calls',
  CallRecordSchema,
  'Calls, newest first; follow `_links.next` for older ones.',
)
const CallInputSchema = z
  .object({
    tool: z.string().min(3).max(160).openapi({ example: 'cookbook.research_recipes' }),
    arguments: Args.default({}),
    interactive: z.boolean().default(false).openapi({
      description:
        'You answer questions the upstream asks mid-call (status `asked`). Without it the gateway declines them for you and says so in the result.',
    }),
    answers: AnswersSchema.optional(),
  })
  .openapi('CallInput', { description: 'Which tool to run and its arguments.' })
const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({
  content: { [HAL_JSON]: { schema } },
  description,
})
const json = <Schema extends z.ZodTypeAny>(schema: Schema) => ({
  required: true,
  content: { 'application/json': { schema } },
})

/** The log's filters, shared by the list and the export. */
const CALL_FILTERS = {
  tool: z.string().max(160).optional().openapi({ description: 'Only calls of this tool.' }),
  client: z.string().max(40).optional().openapi({ description: 'Owner only: one client’s calls.' }),
  upstream: z.string().max(40).optional().openapi({ description: 'Only calls to this upstream.' }),
  status: z
    .string()
    .regex(STATUSES)
    .optional()
    .openapi({ description: 'Only these outcomes, comma-separated.', example: 'tool_error,failed' }),
  via: z.enum(['rest', 'mcp', 'passthrough', 'app']).optional().openapi({ description: 'Only this door.' }),
  kind: z
    .string()
    .regex(/^(tool|manual|playbook|link)(,(tool|manual|playbook|link))*$/)
    .optional()
    .openapi({ description: 'Only these kinds, comma-separated (all when absent).', example: 'manual,playbook' }),
  since: z.iso.datetime().optional().openapi({ description: 'Only calls at or after this moment (ISO 8601).' }),
  until: z.iso.datetime().optional().openapi({ description: 'Only calls before this moment (ISO 8601).' }),
  pack: z
    .string()
    .max(40)
    .optional()
    .openapi({ description: 'Owner only: calls by keys locked to this pack (its name).' }),
}

export const routes = {
  call: createRoute({
    method: 'post',
    path: PATH,
    operationId: 'callTool',
    tags: [TAG],
    summary: 'Run a tool',
    description:
      'Runs a tool through the gateway with its stored credentials. Read the tool first (GET /api/tools/{name}) for its input schema. Tools that change things need write scope.',
    request: { body: json(CallInputSchema) },
    responses: { 200: ok('The result.', CallResultSchema), ...problemResponses(400, 401, 403, 404, 429, 503) },
  }),
  callNamed: createRoute({
    method: 'post',
    path: '/api/tools/{name}/calls',
    operationId: 'callNamedTool',
    tags: [TAG],
    summary: 'Run this tool',
    description:
      'The same as POST /api/calls with the tool in the path and its arguments as the whole body: handy for scripts and typed clients.',
    request: {
      params: z.object({
        name: z.string().min(3).max(160).openapi({ description: 'The tool name, `<upstream>.<tool>`.' }),
      }),
      body: json(Args),
    },
    responses: { 200: ok('The result.', CallResultSchema), ...problemResponses(400, 401, 403, 404, 429, 503) },
  }),
  list: createRoute({
    method: 'get',
    path: PATH,
    operationId: 'listCalls',
    tags: [TAG],
    summary: 'Call log',
    description:
      'Calls, newest first: every call for the owner, a client’s own otherwise. Filters combine; follow `_links.next` for older calls.',
    request: {
      query: z.object({
        ...CALL_FILTERS,
        limit: limitQuery({ fallback: 50, max: 500 }),
        cursor: cursorQuery,
      }),
    },
    responses: { 200: ok('Calls.', CallPageSchema), ...problemResponses(400, 401, 403) },
  }),
  export: createRoute({
    method: 'get',
    path: `${PATH}/export`,
    operationId: 'exportCalls',
    tags: [TAG],
    summary: 'Export the call log',
    description:
      'The calls matching the filters as CSV, newest first, at most 10,000 (owner only). Never arguments or results.',
    request: { query: z.object(CALL_FILTERS) },
    responses: {
      200: { content: { 'text/csv': { schema: z.string() } }, description: 'The calls as CSV.' },
      ...problemResponses(400, 401, 403),
    },
  }),
  get: createRoute({
    method: 'get',
    path: `${PATH}/{id}`,
    operationId: 'getCall',
    tags: [TAG],
    summary: 'One call',
    description: 'One call from the log: who made it, which tool, how it ended and how long it took.',
    request: {
      params: z.object({
        id: z
          .string()
          .min(3)
          .max(40)
          .openapi({ description: 'The call id (`call_…`), from a call result or the log.' }),
      }),
    },
    responses: { 200: ok('The call.', CallRecordSchema), ...problemResponses(401, 403, 404) },
  }),
  result: createRoute({
    method: 'get',
    path: `${PATH}/{id}/result`,
    operationId: 'getHeldResult',
    tags: [TAG],
    summary: 'A page of a big result',
    description:
      'One page of a result that was over the client’s MCP cap. Kept for an hour after the call; follow `_links.next` for the following page.',
    request: {
      params: z.object({ id: z.string().min(3).max(40).openapi({ description: 'The call id from the cut result.' }) }),
      query: z.object({
        page: z.coerce.number().int().min(1).max(10_000).default(1).openapi({ description: 'Which page (from 1).' }),
      }),
    },
    responses: { 200: ok('The page.', HeldPageSchema), ...problemResponses(400, 401, 403, 404) },
  }),
  payload: createRoute({
    method: 'get',
    path: `${PATH}/{id}/payload`,
    operationId: 'getCallPayload',
    tags: [TAG],
    summary: 'What a call sent and got back',
    description: 'The arguments and the full result (or the error) of one call, kept sealed for 30 days (owner only).',
    request: { params: z.object({ id: z.string().min(3).max(40).openapi({ description: 'The call id.' }) }) },
    responses: { 200: ok('The payload.', CallPayloadSchema), ...problemResponses(401, 403, 404) },
  }),
}
