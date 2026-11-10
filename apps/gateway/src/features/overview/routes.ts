/** Overview routes (owner only): Home in one call, and the gateway's own state for Settings. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'
import { UnansweredSchema } from '../searches/routes.js'

export const PATH = '/api/overview'
export const SYSTEM_PATH = '/api/system'
export const STATS_PATH = '/api/overview/stats'
export const TAG = 'Overview'

const Outcomes = z
  .object({
    total: z.number().int(),
    ok: z.number().int(),
    toolErrors: z.number().int(),
    refused: z.number().int(),
    failed: z.number().int(),
  })
  .openapi('CallOutcomes', { description: 'Calls in a window, by how they ended.' })
const Bucket = z
  .object({
    at: z.string().openapi({ description: 'The hour (`2026-11-08T12`) or day (`2026-11-08`), UTC.' }),
    total: z.number().int(),
    errors: z.number().int().openapi({ description: 'Tool errors and upstream failures.' }),
  })
  .openapi('CallBucket', { description: 'Calls in one hour or day.' })
const SetupStepSchema = z
  .object({
    id: z.enum(['connect', 'try', 'key', 'first-call', 'pin']),
    title: z.string(),
    done: z.boolean(),
    href: z.string().openapi({ description: 'Where in /app the step is done.' }),
  })
  .openapi('SetupStep', { description: 'One step of getting started.' })
const UpstreamHealthSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    kind: z.enum(['mcp', 'http', 'composio', 'sample']),
    status: z.enum(['new', 'live', 'failing']),
    enabled: z.boolean(),
    lastError: z.string().nullable(),
    syncedAt: z.string().nullable(),
    toolCount: z.number().int(),
    calls24h: z.number().int(),
    failed24h: z.number().int(),
    p50Ms: z.number().int().nullable().openapi({ description: 'Median time of the last day’s answered calls.' }),
  })
  .openapi('UpstreamHealth', { description: 'An upstream, how it is and how much it was used today.' })
const NudgeSchema = z
  .object({
    kind: z.enum(['reviews', 'pack_wording', 'failing_upstream', 'quiet_key', 'unused_upstream', 'smart_grouping']),
    message: z.string(),
    action: z.string(),
    href: z.string(),
  })
  .openapi('Nudge', { description: 'Something that needs the owner, with where to act on it.' })
const OverviewSchema = z
  .object({
    setup: z.object({
      steps: z.array(SetupStepSchema),
      done: z.number().int(),
      total: z.number().int(),
      complete: z.boolean(),
      next: SetupStepSchema.shape.id.nullable(),
    }),
    totals: z.object({
      upstreams: z.number().int(),
      live: z.number().int(),
      failing: z.number().int(),
      tools: z.number().int(),
      clients: z.number().int().openapi({ description: 'Clients that are not revoked.' }),
      pendingReviews: z.number().int(),
    }),
    calls: z.object({ last24h: Outcomes, last7d: Outcomes, hourly: z.array(Bucket), daily: z.array(Bucket) }),
    upstreams: z.array(UpstreamHealthSchema),
    topTools: z.array(z.object({ name: z.string(), calls7d: z.number().int() })),
    unanswered: z.array(UnansweredSchema).openapi({ description: 'What agents looked for in the last 7 days.' }),
    findability: z
      .object({
        searches: z.number().int().openapi({ description: 'Agents’ tool searches in the last 7 days.' }),
        found: z.number().int().openapi({ description: 'Those followed by a call to a tool they found (10 minutes).' }),
        rate: z.number().nullable().openapi({ description: 'found ÷ searches, null without searches.' }),
        reads: z
          .object({ manual: z.number().int(), playbook: z.number().int(), link: z.number().int() })
          .openapi({ description: 'Manuals read, playbooks fetched and links followed by agents, 7 days.' }),
        manuals: z
          .array(z.object({ name: z.string(), upstream: z.string().nullable(), count: z.number().int() }))
          .openapi({ description: 'The manuals agents read most, 7 days.' }),
      })
      .openapi({ description: 'Whether agents find what they need: searches that led to a call, and reads.' }),
    nudges: z.array(NudgeSchema),
    firstAgentCallAt: z.string().nullable(),
    _links: LinksSchema,
  })
  .openapi('Overview', { description: 'Everything Home shows, in one answer.' })
const SystemSchema = z
  .object({
    version: z.string(),
    node: z.string(),
    startedAt: z.string(),
    database: z.object({ bytes: z.number().int() }),
    backups: z.array(z.object({ file: z.string(), bytes: z.number().int(), at: z.string() })).openapi({
      description: 'Daily copies of the database in the state directory, newest first.',
    }),
    keys: z
      .object({
        masterKey: z.enum(['env', 'file']).openapi({
          description:
            '`env`: GATEWAY_MASTER_KEY is set. `file`: the instance made it and keeps it in instance.json beside its data.',
        }),
      })
      .openapi({ description: 'Where the instance’s keys live, so the owner knows what to back up.' }),
    build: z
      .string()
      .nullable()
      .openapi({ description: 'The commit this deploy was built from, when the image says.' }),
    jobs: z.array(
      z
        .object({
          name: z.enum(['sync', 'backup']),
          at: z.string().nullable().openapi({ description: 'When it last ran, across restarts; null if never.' }),
          ok: z.boolean().nullable(),
          detail: z.string().nullable().openapi({ description: 'What the run did, or what failed.' }),
          ms: z.number().int().nullable().openapi({ description: 'How long the run took.' }),
          next: z.string().openapi({ description: 'When it is next due.' }),
          running: z.boolean(),
        })
        .openapi('JobRun', { description: 'A scheduled job: its last run and when the next is due.' }),
    ),
    liveSync: z
      .array(
        z
          .object({
            upstream: z.string(),
            state: z.enum(['listening', 'reconnecting', 'quiet']).openapi({
              description:
                '`listening`: its changes sync within seconds. `reconnecting`: the stream dropped. `quiet`: it announces nothing, so the hourly sync covers it.',
            }),
            since: z.string(),
            lastChangeAt: z.string().nullable().openapi({ description: 'Its last announced change.' }),
            error: z.string().nullable(),
          })
          .openapi('LiveSync', { description: 'Whether the gateway hears an upstream’s changes as they happen.' }),
      )
      .openapi({ description: 'One per enabled upstream, by id (empty until the server starts listening).' }),
    features: z.object({
      meaningSearch: z.boolean().openapi({ description: 'Tool search by meaning (OpenRouter key set).' }),
      traces: z.boolean().openapi({ description: 'Call metadata goes to Langfuse.' }),
      access: z.boolean().openapi({ description: 'Cloudflare Access signs the owner in.' }),
      oauth: z.boolean().openapi({ description: 'Agents can get tokens with OAuth (claude.ai connectors).' }),
      alerts: z.boolean().openapi({ description: 'Review notices go to a Discord webhook.' }),
    }),
    publicOrigin: z.string(),
    serverName: z.string().openapi({
      description: 'The name agents register the gateway under (`gw`): hosts build command names from it.',
    }),
    _links: LinksSchema,
  })
  .openapi('System', { description: 'The gateway itself: version, storage, backups and jobs.' })

const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({
  content: { [HAL_JSON]: { schema } },
  description,
})

const Tile = z.object({
  calls: z.number().int(),
  problems: z.number().int().openapi({ description: 'Tool errors, refusals and upstream failures.' }),
  medianMs: z
    .number()
    .int()
    .nullable()
    .openapi({ description: 'Median time of the calls that reached their upstream.' }),
  searches: z.number().int(),
  found: z.number().int().openapi({ description: 'Searches a call to a tool it found followed within ten minutes.' }),
})
const StatsSchema = z
  .object({
    range: z.enum(['24h', '7d', '30d']),
    since: z.string(),
    previousSince: z.string().openapi({ description: 'Where the window before this one starts: the comparison.' }),
    bucket: z.enum(['hour', 'day']),
    scope: z.object({ client: z.string().nullable(), pack: z.string().nullable(), via: z.string().nullable() }),
    tiles: z.object({ now: Tile, before: Tile }),
    series: z.array(Bucket),
    tools: z.array(z.object({ name: z.string(), calls: z.number().int(), problems: z.number().int() })),
    agents: z.array(
      z.object({ id: z.string(), name: z.string(), calls: z.number().int(), problems: z.number().int() }),
    ),
    upstreams: z.array(
      z.object({
        id: z.string(),
        calls: z.number().int(),
        problems: z.number().int(),
        medianMs: z.number().int().nullable(),
      }),
    ),
    unanswered: z.array(UnansweredSchema),
    _links: LinksSchema,
  })
  .openapi('OverviewStats', { description: 'Tool calls in one window and the one before it, scoped and filtered.' })

export const routes = {
  stats: createRoute({
    method: 'get',
    path: STATS_PATH,
    operationId: 'getOverviewStats',
    tags: [TAG],
    summary: 'Numbers for a window',
    description:
      'Tool calls over 24 hours, 7 days or 30 days, compared with the window before: tiles, a series by outcome and ranked tools, agents and servers. Scope to one agent or a pack’s keys, and to one door (owner only).',
    request: {
      query: z.object({
        range: z.enum(['24h', '7d', '30d']).default('7d').openapi({ description: 'The window.' }),
        via: z.enum(['rest', 'mcp', 'passthrough', 'app']).optional().openapi({ description: 'Only this door.' }),
        client: z.string().max(40).optional().openapi({ description: 'Only this agent’s calls.' }),
        pack: z.string().max(40).optional().openapi({ description: 'Only calls by keys locked to this pack.' }),
      }),
    },
    responses: { 200: ok('The numbers.', StatsSchema), ...problemResponses(400, 401, 403, 404) },
  }),
  overview: createRoute({
    method: 'get',
    path: PATH,
    operationId: 'getOverview',
    tags: [TAG],
    summary: 'Overview',
    description:
      'Setup progress, totals, calls per hour and day, each upstream’s health, the most used tools, what agents looked for and what needs the owner (owner only).',
    responses: { 200: ok('The overview.', OverviewSchema), ...problemResponses(401, 403) },
  }),
  system: createRoute({
    method: 'get',
    path: SYSTEM_PATH,
    operationId: 'getSystem',
    tags: [TAG],
    summary: 'The gateway itself',
    description:
      'Version, database size, backups, the last run of each job and which optional parts are on (owner only).',
    responses: { 200: ok('The system.', SystemSchema), ...problemResponses(401, 403) },
  }),
  runJob: createRoute({
    method: 'post',
    path: `${SYSTEM_PATH}/jobs/{name}/runs`,
    operationId: 'runJob',
    tags: [TAG],
    summary: 'Run a job now',
    description:
      'Runs the hourly sync or the daily backup now and answers when it is done, with what it did; a run already going is joined (owner only).',
    request: {
      params: z.object({
        name: z
          .enum(['sync', 'backup'])
          .openapi({ param: { name: 'name', in: 'path' }, description: 'The job: `sync` or `backup`.' }),
      }),
    },
    responses: { 200: ok('The system.', SystemSchema), ...problemResponses(401, 403, 409) },
  }),
}
