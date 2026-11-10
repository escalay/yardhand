/** AI routes (owner only): the gateway's AI jobs, where each setting comes from, a test call, and models to pick. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'
import { AI_JOBS, PROVIDERS } from './config.js'

export const TAG = 'AI'
const FROM = z.enum(['settings', 'env', 'default']).openapi({
  description: '`settings`: saved here, wins. `env`: from .env. `default`: neither says.',
})
const field = <T extends z.ZodTypeAny>(value: T) => z.object({ value, from: FROM, env: z.string().nullable() })
const ProviderSchema = z.enum(Object.keys(PROVIDERS) as [keyof typeof PROVIDERS, ...(keyof typeof PROVIDERS)[]])

const JobSchema = z
  .object({
    job: z.enum(AI_JOBS),
    title: z.string(),
    does: z.string().openapi({ description: 'What the job does, in a sentence.' }),
    ready: z.boolean().openapi({ description: 'It has what it needs to run (a key, unless the server is local).' }),
    provider: field(ProviderSchema),
    baseUrl: field(z.string()),
    key: z
      .object({ set: z.boolean(), from: FROM, env: z.string().nullable() })
      .openapi({ description: 'Whether a key is set and where from; the key itself never leaves the gateway.' }),
    model: field(z.string()).nullable().openapi({ description: 'For search: the embedding model (set by the kit).' }),
    writerModel: field(z.string()).nullable().openapi({ description: 'For grouping: the model that names groups.' }),
    deciderModel: field(z.string()).nullable().openapi({ description: 'For grouping: the model that files tools.' }),
    deciderProtocol: field(z.enum(['typesafe', 'openai']))
      .nullable()
      .openapi({ description: '`typesafe`: TypeSafe’s System One API. `openai`: a chat model asked to choose.' }),
  })
  .openapi('AiJob', { description: 'One of the gateway’s AI jobs and its settings.' })

const AiSchema = z
  .object({
    jobs: z.array(JobSchema),
    providers: z.array(z.object({ id: ProviderSchema, title: z.string(), baseUrl: z.string() })),
    _links: LinksSchema,
  })
  .openapi('AiSettings', { description: 'The gateway’s AI jobs.' })

const CheckSchema = z.object({ name: z.string(), ok: z.boolean(), ms: z.number().int(), detail: z.string() })
const TestSchema = z
  .object({ job: z.enum(AI_JOBS), ok: z.boolean(), checks: z.array(CheckSchema) })
  .openapi('AiTest', { description: 'What a test call to each of the job’s models said.' })

const ModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    contextLength: z.number().int().nullable(),
    price: z
      .object({ input: z.number(), output: z.number() })
      .nullable()
      .openapi({ description: 'USD per million tokens.' }),
    pinned: z.boolean().openapi({ description: 'Suggested first: TypeSafe’s decision models.' }),
  })
  .openapi('AiModel', { description: 'A model to pick.' })
const ModelsSchema = z.object({ count: z.number().int(), models: z.array(ModelSchema) }).openapi('AiModels', {
  description: 'Models the provider offers, for the picker.',
})

const PatchSchema = z
  .object({
    provider: ProviderSchema.nullable().optional(),
    baseUrl: z.string().url().nullable().optional(),
    key: z.string().min(8).max(500).nullable().optional(),
    writerModel: z.string().min(2).max(200).nullable().optional(),
    deciderModel: z.string().min(2).max(200).nullable().optional(),
    deciderProtocol: z.enum(['typesafe', 'openai']).nullable().optional(),
  })
  .openapi('AiJobPatch', {
    description:
      'What to change; null takes a field back to .env. The key is sealed in the vault and never shown again.',
  })

const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({
  content: { [HAL_JSON]: { schema } },
  description,
})
const job = z.enum(AI_JOBS).openapi({ param: { name: 'job', in: 'path' }, description: '`search` or `grouping`.' })

export const routes = {
  get: createRoute({
    method: 'get',
    path: '/api/ai',
    operationId: 'getAiSettings',
    tags: [TAG],
    summary: 'AI settings',
    description:
      'The gateway’s AI jobs (search by meaning, smart grouping), each setting with where it comes from: Settings, .env or a default (owner only).',
    responses: { 200: ok('The AI jobs.', AiSchema), ...problemResponses(401, 403) },
  }),
  update: createRoute({
    method: 'patch',
    path: '/api/ai/{job}',
    operationId: 'updateAiJob',
    tags: [TAG],
    summary: 'Change an AI job',
    description:
      'Saves a job’s provider, address, key or models; they win over .env from then on. null takes a field back to .env (owner only).',
    request: {
      params: z.object({ job }),
      body: { required: true, content: { 'application/json': { schema: PatchSchema } } },
    },
    responses: { 200: ok('The AI jobs.', AiSchema), ...problemResponses(400, 401, 403) },
  }),
  test: createRoute({
    method: 'post',
    path: '/api/ai/{job}/test',
    operationId: 'testAiJob',
    tags: [TAG],
    summary: 'Test an AI job',
    description: 'One small call to each of the job’s models, with how long it took and what it said (owner only).',
    request: { params: z.object({ job }) },
    responses: { 200: ok('What each model said.', TestSchema), ...problemResponses(401, 403) },
  }),
  models: createRoute({
    method: 'get',
    path: '/api/ai/models',
    operationId: 'listAiModels',
    tags: [TAG],
    summary: 'Models to pick',
    description:
      'The models a provider offers, for the picker: OpenRouter’s catalogue with names, prices and context sizes (TypeSafe’s decision models first), else the server’s own /models (owner only).',
    request: {
      query: z.object({
        provider: ProviderSchema.optional().openapi({ description: 'Which provider; default the grouping job’s.' }),
        q: z.string().max(100).optional().openapi({ description: 'Only models whose id or name has these words.' }),
        for: z.enum(['writer', 'typesafe', 'chat']).optional().openapi({
          description:
            'What the model is for: `writer` (names groups: chat models), `typesafe` (files tools over TypeSafe’s System One: its decision models only), `chat` (files tools as a chat model). All when absent.',
        }),
      }),
    },
    responses: { 200: ok('Models.', ModelsSchema), ...problemResponses(401, 403, 503) },
  }),
}
