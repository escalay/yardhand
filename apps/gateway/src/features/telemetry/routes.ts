/** Usage telemetry route (owner only): whether it is on, where it sends, and the exact report. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'

export const PATH = '/api/system/telemetry'
export const TAG = 'Telemetry'

const Count = z
  .enum(['0', '1-10', '11-100', '101-1k', '1k-10k', '10k+'])
  .openapi('UsageCount', { description: 'A count as a range.' })

/** Schema 1, field for field: a report that carries anything else fails its test here and is refused at the collector. */
export const ReportSchema = z
  .strictObject({
    install: z.enum(['compose', 'cloud-init', 'render', 'fly', 'source', 'other']).openapi({
      description: 'How it was installed, as the template that started it says.',
    }),
    arch: z.enum(['x64', 'arm64', 'other']).openapi({ description: 'The processor it runs on.' }),
    age: z.enum(['0', '1-7', '8-30', '31-90', '91-365', '365+']).openapi({
      description: 'Days since it first ran a version with telemetry.',
    }),
    https: z.boolean().openapi({ description: 'Its own address starts with https://.' }),
    database: z.enum(['<10MB', '10-100MB', '100MB-1GB', '1GB+']).openapi({ description: 'The database file’s size.' }),
    claimed: z.boolean().openapi({ description: 'It has an owner.' }),
    connections: Count.openapi({ description: 'Connections, of any kind.' }),
    connections_mcp: z.boolean().openapi({ description: 'At least one is an MCP server.' }),
    connections_http: z.boolean().openapi({ description: 'At least one is a REST API.' }),
    connections_composio: z.boolean().openapi({ description: 'At least one is Composio.' }),
    tools: Count.openapi({ description: 'Tools it serves.' }),
    clients_key: Count.openapi({ description: 'Agents with a key.' }),
    clients_oauth: Count.openapi({ description: 'Agents signed in with OAuth.' }),
    packs: Count.openapi({ description: 'Packs.' }),
    reviews_waiting: Count.openapi({ description: 'Changes waiting for review.' }),
    calls_1d: Count.openapi({ description: 'Calls in the last day.' }),
    calls: Count.openapi({ description: 'Calls in the last 7 days.' }),
    calls_mcp: Count.openapi({ description: 'Of those, over MCP.' }),
    calls_rest: Count.openapi({ description: 'Of those, over REST.' }),
    calls_app: Count.openapi({ description: 'Of those, from the app.' }),
    calls_tool_error: Count.openapi({ description: 'Of those, the tool answered with an error.' }),
    calls_refused: Count.openapi({ description: 'Of those, refused by the gateway.' }),
    calls_failed: Count.openapi({ description: 'Of those, the upstream failed.' }),
    searches: Count.openapi({ description: 'Tool searches in the last 7 days.' }),
    clients_active: Count.openapi({ description: 'Agents that called in the last 7 days.' }),
    meaning_search: z.boolean().openapi({ description: 'Search by meaning is on.' }),
    ai_grouping: z.enum(['off', 'openrouter', 'openai', 'local', 'custom']).openapi({
      description: 'Which kind of provider smart grouping uses, or `off`.',
    }),
    langfuse: z.boolean().openapi({ description: 'Call traces go to Langfuse.' }),
    discord: z.boolean().openapi({ description: 'Review alerts go to Discord.' }),
    access_signin: z.boolean().openapi({ description: 'Cloudflare Access signs the owner in.' }),
  })
  .openapi('UsageReport', { description: 'The daily usage report: ranges and yes/no answers, never a name.' })

const BodySchema = z
  .object({
    schema: z.number().int().openapi({ description: 'The number of the field list; a new field is a new number.' }),
    instance: z.string().openapi({ description: 'A random id kept by this instance, derived from nothing.' }),
    version: z.string(),
    report: ReportSchema,
  })
  .openapi('UsageReportBody', { description: 'Everything one report carries, as it is posted.' })

const TelemetrySchema = z
  .object({
    on: z.boolean(),
    off: z.string().nullable().openapi({
      description: 'Why it is off: `GATEWAY_TELEMETRY is off` or `DO_NOT_TRACK is set`; null when on.',
    }),
    url: z.string().openapi({ description: 'Where reports go (GATEWAY_TELEMETRY_URL).' }),
    firstAt: z.string().openapi({ description: 'The first report goes no earlier than this: a day after first run.' }),
    next: BodySchema.openapi({ description: 'What it would send now.' }),
    sent: z
      .object({ at: z.string(), body: BodySchema })
      .nullable()
      .openapi({ description: 'The last report sent, as it was sent; null if none yet.' }),
    latest: z.string().nullable().openapi({
      description: 'The newest release, as the collector’s last answer named it; null until a report is sent.',
    }),
    _links: LinksSchema,
  })
  .openapi('Telemetry', { description: 'Usage telemetry: whether it is on, where it sends and the exact report.' })

export const routes = {
  telemetry: createRoute({
    method: 'get',
    path: PATH,
    operationId: 'getTelemetry',
    tags: [TAG],
    summary: 'Usage telemetry',
    description:
      'Whether the daily usage report is on, where it goes, when the first one goes, the exact report it would send now and the last one sent (owner only). Reading it sends nothing. It is switched off in the environment: GATEWAY_TELEMETRY=off.',
    responses: {
      200: { content: { [HAL_JSON]: { schema: TelemetrySchema } }, description: 'Usage telemetry.' },
      ...problemResponses(401, 403, 409),
    },
  }),
}
