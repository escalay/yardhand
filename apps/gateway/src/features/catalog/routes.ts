/** Catalog routes: the manuals, playbooks and links of the upstreams a caller may use. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'

export const PLAYBOOKS_PATH = '/api/playbooks'
export const MANUALS_PATH = '/api/manuals'
export const LINKS_PATH = '/api/links'
export const RESOURCES_PATH = '/api/resources'
export const TAG = 'Catalog'

const ArgumentSchema = z
  .object({ name: z.string(), description: z.string().nullable(), required: z.boolean() })
  .openapi('PlaybookArgument', { description: 'One argument a playbook takes.' })

export const PlaybookSchema = z
  .object({
    name: z
      .string()
      .openapi({ description: 'As agents see it: `<upstream>-<prompt>`.', example: 'cookbook-plan-a-dinner' }),
    upstream: z.string(),
    prompt: z.string().openapi({ description: 'The upstream’s own name for it.' }),
    title: z
      .string()
      .openapi({ description: 'How clients that show titles list it.', example: 'Cookbook · Plan a dinner' }),
    description: z.string(),
    arguments: z.array(ArgumentSchema),
    offered: z
      .boolean()
      .openapi({ description: 'Offered to agents: its upstream’s playbooks are switched on (owner sees all).' }),
    _links: LinksSchema,
  })
  .openapi('Playbook', { description: 'A prompt an upstream offers: a ready-made way to do one task with its tools.' })
const PlaybookListSchema = z
  .object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ playbooks: z.array(PlaybookSchema) }) })
  .openapi('PlaybookList', { description: 'Playbooks, best match first when searching, else by name.' })

const ManualCardSchema = z
  .object({
    name: z
      .string()
      .openapi({ description: 'As agents see it: the upstream id, or `<upstream>.<skill>`.', example: 'cookbook' }),
    upstream: z.string(),
    skill: z.string().openapi({ description: 'The skill’s own name.' }),
    description: z.string(),
    files: z.array(z.string()).openapi({ description: 'Its files, `SKILL.md` first.' }),
    _links: LinksSchema,
  })
  .openapi('ManualCard', { description: 'An upstream’s manual: how it says to use its tools.' })
const ManualListSchema = z
  .object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ manuals: z.array(ManualCardSchema) }) })
  .openapi('ManualList', { description: 'Manuals, by name.' })
export const ManualSchema = ManualCardSchema.extend({
  note: z.string().openapi({ description: 'What the gateway adds on top: how its tools and links are reached here.' }),
  text: z.string().openapi({ description: '`SKILL.md` as agents read it: the note after its frontmatter.' }),
  original: z.string().nullable().openapi({ description: '`SKILL.md` as the upstream wrote it (owner only).' }),
  references: z
    .record(z.string(), z.string())
    .openapi({ description: 'Its other files by path, as written: read when the manual points at them.' }),
}).openapi('Manual', { description: 'A manual in full.' })

export const LinkSchema = z
  .object({
    upstream: z.string(),
    kind: z.enum(['template', 'resource']),
    uri: z
      .string()
      .openapi({ description: 'The template or URI, as the upstream gives it.', example: 'cookbook://recipes/{id}' }),
    title: z.string().nullable(),
    description: z.string(),
    mimeType: z.string().nullable(),
    _links: LinksSchema,
  })
  .openapi('UpstreamLink', {
    description: 'A kind of link an upstream serves: read one with GET /api/resources?uri=….',
  })
const LinkListSchema = z
  .object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ links: z.array(LinkSchema) }) })
  .openapi('LinkList', { description: 'Resource templates and listed resources, by upstream.' })

const MessagesSchema = z
  .object({
    name: z.string(),
    callId: z.string().openapi({ description: 'This read in the call log.' }),
    description: z.string().nullable(),
    messages: z
      .array(z.unknown())
      .openapi({ description: 'MCP prompt messages (role + content): what the upstream would have the agent read.' }),
    _links: LinksSchema,
  })
  .openapi('PlaybookMessages', { description: 'A playbook filled in with arguments, as the upstream wrote it.' })
const ResourceSchema = z
  .object({
    uri: z.string(),
    upstream: z.string(),
    callId: z.string().openapi({ description: 'This read in the call log.' }),
    contents: z.array(
      z.object({
        uri: z.string(),
        mimeType: z.string().nullable(),
        text: z.string().nullable(),
        blob: z.string().nullable().openapi({ description: 'Base64, for anything not text.' }),
      }),
    ),
    _links: LinksSchema,
  })
  .openapi('ResourceRead', { description: 'What a link holds, read with the upstream’s credential.' })

const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({
  content: { [HAL_JSON]: { schema } },
  description,
})
const upstreamFilter = z.string().max(40).optional().openapi({ description: 'Only this upstream.' })

export const routes = {
  playbooks: createRoute({
    method: 'get',
    path: PLAYBOOKS_PATH,
    operationId: 'listPlaybooks',
    tags: [TAG],
    summary: 'Playbooks',
    description:
      'Prompts the upstreams you may use offer, as playbooks: a ready-made way to do one task. Search with `q` (what you want to do).',
    request: {
      query: z.object({
        q: z.string().max(200).optional().openapi({ description: 'What you want to do.', example: 'plan a dinner' }),
        upstream: upstreamFilter,
        limit: z.coerce.number().int().min(1).max(200).default(100).openapi({ description: 'At most this many.' }),
      }),
    },
    responses: { 200: ok('Playbooks.', PlaybookListSchema), ...problemResponses(400, 401, 403) },
  }),
  playbook: createRoute({
    method: 'get',
    path: `${PLAYBOOKS_PATH}/{name}`,
    operationId: 'getPlaybook',
    tags: [TAG],
    summary: 'A playbook',
    description: 'One playbook with its arguments.',
    request: {
      params: z.object({
        name: z.string().min(3).max(128).openapi({ description: 'The playbook name, `<upstream>-<prompt>`.' }),
      }),
    },
    responses: { 200: ok('The playbook.', PlaybookSchema), ...problemResponses(401, 403, 404) },
  }),
  messages: createRoute({
    method: 'get',
    path: `${PLAYBOOKS_PATH}/{name}/messages`,
    operationId: 'getPlaybookMessages',
    tags: [TAG],
    summary: 'Use a playbook',
    description:
      'A playbook filled in with your arguments: the steps its upstream would have you follow with its tools. Logged like a call.',
    request: {
      params: z.object({
        name: z.string().min(3).max(128).openapi({ description: 'The playbook name, `<upstream>-<prompt>`.' }),
      }),
      query: z.object({
        arguments: z
          .string()
          .max(20_000)
          .optional()
          .openapi({ description: 'Its arguments as a JSON object of strings.', example: '{"task":"a dinner"}' }),
      }),
    },
    responses: { 200: ok('The filled-in playbook.', MessagesSchema), ...problemResponses(400, 401, 403, 404, 503) },
  }),
  manuals: createRoute({
    method: 'get',
    path: MANUALS_PATH,
    operationId: 'listManuals',
    tags: [TAG],
    summary: 'Manuals',
    description:
      'The manuals of the upstreams you may use: how each says its tools should be used. Read one before its tools.',
    request: { query: z.object({ upstream: upstreamFilter }) },
    responses: { 200: ok('Manuals.', ManualListSchema), ...problemResponses(400, 401, 403) },
  }),
  manual: createRoute({
    method: 'get',
    path: `${MANUALS_PATH}/{name}`,
    operationId: 'getManual',
    tags: [TAG],
    summary: 'A manual',
    description: 'One manual in full, as agents read it, with its other files.',
    request: {
      params: z.object({
        name: z.string().min(1).max(128).openapi({ description: 'The manual name, from GET /api/manuals.' }),
      }),
    },
    responses: { 200: ok('The manual.', ManualSchema), ...problemResponses(401, 403, 404) },
  }),
  links: createRoute({
    method: 'get',
    path: LINKS_PATH,
    operationId: 'listLinks',
    tags: [TAG],
    summary: 'Kinds of links',
    description:
      'The resource templates and listed resources of the upstreams you may use: the links their tools return, which GET /api/resources?uri=… reads.',
    request: { query: z.object({ upstream: upstreamFilter }) },
    responses: { 200: ok('Links.', LinkListSchema), ...problemResponses(400, 401, 403) },
  }),
  resource: createRoute({
    method: 'get',
    path: RESOURCES_PATH,
    operationId: 'readResource',
    tags: [TAG],
    summary: 'Follow a link',
    description:
      'Reads a link an upstream serves, as a tool returned it (`cookbook://recipes/123`), with the upstream’s credential. `gateway://u/<upstream>/manual` is its manual. Logged like a call.',
    request: {
      query: z.object({
        uri: z
          .string()
          .min(3)
          .max(2000)
          .openapi({ description: 'The link, as given.', example: 'cookbook://recipes/123' }),
        upstream: z
          .string()
          .max(40)
          .optional()
          .openapi({ description: 'Which upstream, when two serve links of the same scheme.' }),
      }),
    },
    responses: { 200: ok('What the link holds.', ResourceSchema), ...problemResponses(400, 401, 403, 404, 503) },
  }),
}
