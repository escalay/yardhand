/**
 * Build routes (owner only): estimate a Build or Refresh with AI, start one (202, then polled), read it, accept its
 * proposal line by line, or discard it.
 */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'
import { FindingSchema, PATH as PACKS_PATH, PackName, PackSchema } from '../packs/routes.js'
import { BUILD_STATUSES } from './schema.js'
import { BUILD_CAP_USD, REHEARSAL_STEPS } from './spend.js'

export const TAG = 'Builds'
export const pathOf = (pack: string, id?: string) => `${PACKS_PATH}/${pack}/builds${id ? `/${id}` : ''}`

const BuildBody = z
  .object({
    mode: z.enum(['build', 'refresh']).openapi({
      description:
        '`build` drafts the pack from its purpose and the tasks. `refresh` also sends the pack as it is (its tools, wording, variables and the values it fills) and its flags, and asks only for changes.',
    }),
    tasks: z
      .array(z.string().trim().min(3).max(300))
      .min(1)
      .max(5)
      .openapi({
        description: `One to five example tasks the pack is for, 300 characters each. Each gets a playbook and is tried first: up to ${REHEARSAL_STEPS} real read calls a task.`,
        example: ['find a quick dinner recipe'],
      }),
  })
  .openapi('PackBuildRequest', { description: 'What to build: the mode, and the example tasks.' })

const Calls = z.object({ likely: z.number().int(), max: z.number().int() })
const EstimateSchema = z
  .object({
    mode: z.enum(['build', 'refresh']),
    usd: z
      .number()
      .nullable()
      .openapi({ description: 'The likely cost on the model, in US dollars; null when no price is known.' }),
    capUsd: z.number().openapi({ description: 'The most a build may spend on the model.' }),
    priceKnown: z.boolean().openapi({ description: 'The model’s list price is known.' }),
    note: z.string().nullable().openapi({ description: 'What to know about the figure, when it is not plain.' }),
    modelCalls: Calls.openapi({ description: 'Asks to the model: likely, and at most.' }),
    tokens: z.number().int().openapi({ description: 'The likely tokens, in and out.' }),
    model: z.string().openapi({ description: 'The model Build with AI asks (Settings › AI).' }),
    realCalls: z.number().int().openapi({
      description:
        'The most real calls the rehearsal may make with your accounts: tools that only read, which may cost on their own. Tools that change things are never run.',
    }),
    _links: LinksSchema,
  })
  .openapi('PackBuildEstimate', { description: 'What a build is likely to cost, before it starts. Nothing is asked.' })

const LineSchema = z
  .object({
    id: z.string().openapi({
      description:
        '`tool:<name>`, `wording:<name>`, `input:<name>.<input>`, `variable:<name>`, `playbook:<name>` or `skill`: what accept takes.',
    }),
    kind: z.enum(['tool', 'wording', 'variable', 'input', 'playbook', 'skill']),
    target: z.string(),
    change: z.enum(['add', 'change', 'remove']),
    before: z.unknown().openapi({ description: 'As the pack has it, or null.' }),
    after: z.unknown().openapi({ description: 'As drafted, or null for a removal.' }),
    reason: z.string().nullable(),
    changesThings: z.boolean().openapi({ description: 'A tool that changes things: never tried in rehearsal.' }),
    suggested: z.boolean().openapi({ description: 'Ticked to begin with.' }),
    needs: z.array(z.string()).openapi({ description: 'The lines it can’t be accepted without.' }),
  })
  .openapi('PackBuildLine', { description: 'One change a proposal makes to a pack.' })

const RehearsalSchema = z.object({
  task: z.string(),
  steps: z.array(
    z.object({
      tool: z.string().openapi({ description: 'The pack’s name for the tool the model chose.' }),
      ran: z.boolean(),
      callId: z.string().nullable().openapi({ description: 'The call in the log (`GET /api/calls/{id}`).' }),
      standIn: z.string().nullable().openapi({ description: 'What the model was told instead, when it didn’t run.' }),
    }),
  ),
  outcome: z.string(),
})

const SpentSchema = z.object({
  usd: z.number(),
  tokens: z.number().int(),
  modelCalls: z.number().int(),
  known: z.boolean().openapi({ description: 'The dollars are real (a list price or the provider’s own figure).' }),
})

export const BuildSchema = z
  .object({
    id: z.string(),
    pack: z.string(),
    mode: z.enum(['build', 'refresh']),
    status: z.enum(BUILD_STATUSES).openapi({
      description:
        '`running`, then `ready` (a proposal to accept), `stopped` (at the cap: what is here can still be accepted) or `failed`; later `accepted` or `discarded`.',
    }),
    step: z.string().nullable().openapi({ description: 'While running: what it is doing.' }),
    tasks: z.array(z.string()),
    estimate: z.object({ usd: z.number().nullable(), tokens: z.number(), modelCalls: Calls }),
    spent: SpentSchema,
    costNote: z.string().nullable(),
    stopped: z.enum(['cap', 'provider']).nullable().openapi({
      description:
        '`cap`: the next ask would have passed $1.00. `provider`: the provider refused for money (402 or 403).',
    }),
    notDone: z.array(z.string()).openapi({ description: 'For a stopped build: what it didn’t get to.' }),
    error: z.string().nullable(),
    proposal: z
      .object({
        model: z.string(),
        lines: z.array(LineSchema),
        skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
        rehearsal: z.array(RehearsalSchema),
        findings: z.array(FindingSchema),
      })
      .nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
    _links: LinksSchema,
  })
  .openapi('PackBuild', { description: 'A Build or Refresh with AI of a pack, and its proposal.' })

const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({
  content: { [HAL_JSON]: { schema } },
  description,
})
const json = <Schema extends z.ZodTypeAny>(schema: Schema) => ({
  required: true,
  content: { 'application/json': { schema } },
})
const name = PackName.openapi({ param: { name: 'name', in: 'path' } })
const id = z.string().min(3).max(40).openapi({ description: 'The build’s id.', example: 'pb_0123456789abcdef' })

export const routes = {
  estimate: createRoute({
    method: 'post',
    path: '/api/packs/{name}/builds/estimate',
    operationId: 'estimatePackBuild',
    tags: [TAG],
    summary: 'Estimate a build',
    description: `What a Build or Refresh with AI is likely to cost on the model, and the most real read calls its rehearsal may make, before anything runs. A build may spend $${BUILD_CAP_USD.toFixed(2)} at most (owner only).`,
    request: { params: z.object({ name }), body: json(BuildBody) },
    responses: { 200: ok('The estimate.', EstimateSchema), ...problemResponses(400, 401, 403, 404, 409) },
  }),
  start: createRoute({
    method: 'post',
    path: '/api/packs/{name}/builds',
    operationId: 'startPackBuild',
    tags: [TAG],
    summary: 'Build or refresh a pack with AI',
    description:
      'Drafts tools with reasons, wording, variables, input modes, playbooks and the skill, tries each task with the pack’s read-only tools, and keeps one proposal. Answers 202 at once: poll the `Location`. Nothing changes in the pack until lines are accepted. One build runs at a time per pack, six an hour per pack (owner only).',
    request: { params: z.object({ name }), body: json(BuildBody) },
    responses: {
      202: { ...ok('Started.', BuildSchema), headers: z.object({ location: z.string() }) },
      ...problemResponses(400, 401, 403, 404, 409, 429),
    },
  }),
  get: createRoute({
    method: 'get',
    path: '/api/packs/{name}/builds/{id}',
    operationId: 'getPackBuild',
    tags: [TAG],
    summary: 'A build',
    description: 'Where a build is, what it spent, and its proposal once it has one (owner only).',
    request: { params: z.object({ name, id }) },
    responses: { 200: ok('The build.', BuildSchema), ...problemResponses(401, 403, 404) },
  }),
  accept: createRoute({
    method: 'post',
    path: '/api/packs/{name}/builds/{id}/accept',
    operationId: 'acceptPackBuild',
    tags: [TAG],
    summary: 'Accept lines of a proposal',
    description:
      'Applies the chosen lines to the pack through its checks and answers the pack. Every line a chosen line needs must be chosen too. Once only, and only onto the pack as it was when the build started (owner only).',
    request: {
      params: z.object({ name, id }),
      body: json(
        z.object({
          lines: z.array(z.string().max(300)).max(500).openapi({ description: 'The ids of the lines to apply.' }),
        }),
      ),
    },
    responses: { 200: ok('The pack.', PackSchema), ...problemResponses(400, 401, 403, 404, 409) },
  }),
  discard: createRoute({
    method: 'delete',
    path: '/api/packs/{name}/builds/{id}',
    operationId: 'discardPackBuild',
    tags: [TAG],
    summary: 'Discard a proposal',
    description: 'Drops a build’s proposal; the pack stays as it is (owner only).',
    request: { params: z.object({ name, id }) },
    responses: { 204: { description: 'Discarded.' }, ...problemResponses(401, 403, 404, 409) },
  }),
}
