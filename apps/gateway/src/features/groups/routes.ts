/** Group routes (owner only): a connection's tool groups and effect switches, and moving a tool between groups. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'

export const TAG = 'Groups'
const EFFECTS = ['reads', 'changes', 'deletes'] as const

const EffectCountsSchema = z.object({ reads: z.number().int(), changes: z.number().int(), deletes: z.number().int() })

const GroupSchema = z
  .object({
    key: z.string(),
    title: z.string(),
    purpose: z.string().nullable().openapi({ description: 'What its tools are for, when a model wrote it.' }),
    source: z.enum(['rules', 'ai', 'owner']).openapi({ description: 'Who made it: the rules, a model, or you.' }),
    off: z.boolean().openapi({ description: 'Switched off: its tools, and new ones filed in it later, are off.' }),
    tools: z.number().int().openapi({ description: 'Its live tools.' }),
    offTools: z.number().int().openapi({ description: 'Of those, how many are off (by the group, an effect or you).' }),
    effects: EffectCountsSchema,
    app: z
      .object({
        logo: z.string().nullable(),
        available: z.number().int().nullable().openapi({ description: 'How many tools Composio has for it.' }),
        fetched: z.boolean().openapi({ description: 'False when switched off: its tools aren’t fetched at all.' }),
      })
      .nullable()
      .openapi({ description: 'For a Composio app.' }),
  })
  .openapi('ToolGroup', { description: 'A group of a connection’s tools, with its switch.' })

const GroupsSchema = z
  .object({
    upstream: z.string(),
    groupedBy: z
      .enum(['rules', 'ai', 'owner', 'apps', 'mixed'])
      .openapi({ description: 'How its groups were made: rules, a model, you, Composio apps, or a mix.' }),
    effects: z.array(
      z.object({
        effect: z.enum(EFFECTS),
        tools: z
          .number()
          .int()
          .openapi({ description: 'Tools the switch holds: those without a setting of their own.' }),
        off: z.boolean().openapi({ description: 'Every tool with this effect is off (unless you set the tool).' }),
      }),
    ),
    yours: z
      .number()
      .int()
      .openapi({ description: 'Tools with a setting of their own, which no effect switch moves.' }),
    groups: z.array(GroupSchema),
    smart: z
      .boolean()
      .openapi({ description: 'Smart grouping is set up (Settings › AI): a regroup can be asked for.' }),
    _links: LinksSchema,
  })
  .openapi('ToolGroups', { description: 'A connection’s tools by group and by effect, with their switches.' })

const ProposedSchema = z
  .object({
    key: z.string().min(1).max(60),
    title: z.string().min(1).max(60),
    purpose: z.string().max(200).nullable(),
    tools: z.array(z.string().max(160)).max(5000),
  })
  .openapi('ProposedGroup', { description: 'A group of a proposed grouping, with the tools filed in it.' })
const RegroupSchema = z
  .object({
    upstream: z.string(),
    before: z.array(z.object({ key: z.string(), title: z.string(), off: z.boolean(), tools: z.array(z.string()) })),
    after: z.array(
      ProposedSchema.extend({
        off: z.boolean().openapi({ description: 'It keeps an off switch from a group of the same key.' }),
      }),
    ),
    moves: z.number().int().openapi({ description: 'Tools that would change group.' }),
    kept: z.array(z.string()).openapi({
      description: 'Tools that stay where they are: ones you moved, and ones in a group switched off.',
    }),
  })
  .openapi('Regroup', {
    description: 'A proposed grouping beside the current one. Nothing changes until it is applied.',
  })

const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({
  content: { [HAL_JSON]: { schema } },
  description,
})
const json = <Schema extends z.ZodTypeAny>(schema: Schema) => ({
  required: true,
  content: { 'application/json': { schema } },
})
const id = z
  .string()
  .min(1)
  .max(40)
  .openapi({ param: { name: 'id', in: 'path' }, description: 'The connection (upstream) id.' })
const key = z
  .string()
  .min(1)
  .max(60)
  .openapi({ param: { name: 'key', in: 'path' }, description: 'The group key.' })

export const routes = {
  list: createRoute({
    method: 'get',
    path: '/api/upstreams/{id}/groups',
    operationId: 'listToolGroups',
    tags: [TAG],
    summary: 'Its tool groups',
    description:
      'A connection’s tools by group (found by rules or a model, or yours) and by effect (reads, changes things, deletes), each with its switch. A Composio connection’s groups are its apps (owner only).',
    request: { params: z.object({ id }) },
    responses: { 200: ok('Its groups.', GroupsSchema), ...problemResponses(401, 403, 404) },
  }),
  create: createRoute({
    method: 'post',
    path: '/api/upstreams/{id}/groups',
    operationId: 'createToolGroup',
    tags: [TAG],
    summary: 'Add a group or an app',
    description:
      'A group of your own to move tools into (`title`), or for a Composio connection another app to list (`app`, its toolkit slug), fetched at once (owner only).',
    request: {
      params: z.object({ id }),
      body: json(
        z
          .object({
            title: z.string().min(1).max(60).optional(),
            app: z
              .string()
              .regex(/^[a-z0-9_]{1,60}$/)
              .optional(),
          })
          .openapi('ToolGroupInput', { description: 'A group by its title, or a Composio app by its slug.' }),
      ),
    },
    responses: { 200: ok('Its groups.', GroupsSchema), ...problemResponses(400, 401, 403, 404, 409) },
  }),
  remove: createRoute({
    method: 'delete',
    path: '/api/upstreams/{id}/groups/{key}',
    operationId: 'deleteToolGroup',
    tags: [TAG],
    summary: 'Delete a group',
    description:
      'Deletes a group; its tools go to Other. A group that is off with tools in it is refused (deleting it would switch them on): turn it on or move its tools first. A Composio app is switched off instead (owner only).',
    request: { params: z.object({ id, key }) },
    responses: { 200: ok('Its groups.', GroupsSchema), ...problemResponses(400, 401, 403, 404, 409) },
  }),
  update: createRoute({
    method: 'patch',
    path: '/api/upstreams/{id}/groups/{key}',
    operationId: 'updateToolGroup',
    tags: [TAG],
    summary: 'Switch or rename a group',
    description:
      'Switches a group off or on (its tools now, and ones filed in it later; a tool you set yourself keeps your setting) or renames it. A Composio app switched off isn’t fetched at all; switched on, it is fetched again (owner only).',
    request: {
      params: z.object({ id, key }),
      body: json(
        z
          .object({ off: z.boolean().optional(), title: z.string().min(1).max(60).optional() })
          .openapi('ToolGroupPatch', { description: 'Its switch and its name.' }),
      ),
    },
    responses: { 200: ok('Its groups.', GroupsSchema), ...problemResponses(400, 401, 403, 404) },
  }),
  effect: createRoute({
    method: 'patch',
    path: '/api/upstreams/{id}/effects/{effect}',
    operationId: 'switchToolEffect',
    tags: [TAG],
    summary: 'Switch an effect',
    description:
      'Switches off or on every tool of a connection that reads, changes things or deletes (a tool you set yourself keeps your setting) (owner only).',
    request: {
      params: z.object({
        id,
        effect: z
          .enum(EFFECTS)
          .openapi({ param: { name: 'effect', in: 'path' }, description: 'reads, changes or deletes.' }),
      }),
      body: json(z.object({ off: z.boolean() }).openapi('ToolEffectPatch', { description: 'Its switch.' })),
    },
    responses: { 200: ok('Its groups.', GroupsSchema), ...problemResponses(400, 401, 403, 404) },
  }),
  regroup: createRoute({
    method: 'post',
    path: '/api/upstreams/{id}/regroup',
    operationId: 'proposeToolGroups',
    tags: [TAG],
    summary: 'Propose a regroup',
    description:
      'Asks the models (Settings › AI) for a fresh grouping of a connection’s tools and shows it beside the current one. Nothing changes until it is applied with PUT …/groups (owner only).',
    request: { params: z.object({ id }) },
    responses: { 200: ok('The proposal.', RegroupSchema), ...problemResponses(400, 401, 403, 404, 409, 503) },
  }),
  apply: createRoute({
    method: 'put',
    path: '/api/upstreams/{id}/groups',
    operationId: 'applyToolGroups',
    tags: [TAG],
    summary: 'Apply a grouping',
    description:
      'Files the tools as a proposal says. Tools you moved and tools in a group switched off stay where they are, groups you made stay; groups left empty go (owner only).',
    request: {
      params: z.object({ id }),
      body: json(
        z
          .object({ groups: z.array(ProposedSchema).min(1).max(40) })
          .openapi('ToolGroupsInput', { description: 'The groups to apply, as a proposal gave them.' }),
      ),
    },
    responses: { 200: ok('Its groups.', GroupsSchema), ...problemResponses(400, 401, 403, 404) },
  }),
  move: createRoute({
    method: 'put',
    path: '/api/tools/{name}/group',
    operationId: 'moveToolToGroup',
    tags: [TAG],
    summary: 'Move a tool to a group',
    description:
      'Files a tool in another group of its connection; it stays there through syncs and regroups (owner only).',
    request: {
      params: z.object({
        name: z
          .string()
          .min(3)
          .max(160)
          .openapi({ param: { name: 'name', in: 'path' }, description: 'The tool, `<upstream>.<tool>`.' }),
      }),
      body: json(z.object({ group: z.string().min(1).max(60) }).openapi('ToolMove', { description: 'Where to.' })),
    },
    responses: { 200: ok('Its connection’s groups.', GroupsSchema), ...problemResponses(400, 401, 403, 404) },
  }),
}
