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
    name: z.string().openapi({
      description: 'As agents see it: `<upstream>-<prompt>`, or the pack’s own name for one it wrote.',
      example: 'cookbook-plan-a-dinner',
    }),
    upstream: z
      .string()
      .nullable()
      .openapi({ description: 'The upstream that offers it; null for a playbook a pack wrote.' }),
    pack: z.string().nullable().openapi({
      description: 'The pack that wrote it, for a playbook written for the pack this request is locked to; else null.',
    }),
    prompt: z.string().openapi({ description: 'The upstream’s own name for it; a pack’s own goes by its one name.' }),
    title: z
      .string()
      .openapi({ description: 'How clients that show titles list it.', example: 'Cookbook · Plan a dinner' }),
    description: z.string(),
    arguments: z.array(ArgumentSchema),
    offered: z.boolean().openapi({
      description:
        'Offered to agents: its upstream’s playbooks are switched on (owner sees all). Always true for a pack’s own.',
    }),
    _links: LinksSchema,
  })
  .openapi('Playbook', {
    description:
      'A ready-made way to do one task: a prompt an upstream offers, or a playbook written for a pack over the pack’s tools.',
  })
const PlaybookListSchema = z
  .object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ playbooks: z.array(PlaybookSchema) }) })
  .openapi('PlaybookList', {
    description: 'Playbooks: a pack’s own first, then the upstreams’, best match first when searching, else by name.',
  })

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
      .openapi({ description: 'MCP prompt messages (role + content): what the agent is to read and follow.' }),
    _links: LinksSchema,
  })
  .openapi('PlaybookMessages', {
    description:
      'A playbook filled in with arguments: as its upstream wrote it, or a pack’s own with the pack’s variables filled in too.',
  })
const ResourceSchema = z
  .object({
    uri: z.string(),
    upstream: z
      .string()
      .nullable()
      .openapi({ description: 'The upstream it was read from; null for a pack’s own skill.' }),
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
  .openapi('ResourceRead', {
    description: 'What a link holds, read with the upstream’s credential, or a pack’s own skill.',
  })

const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({
  content: { [HAL_JSON]: { schema } },
  description,
})
const upstreamFilter = z.string().max(40).optional().openapi({ description: 'Only this upstream.' })
const playbookName = z
  .string()
  .min(3)
  .max(128)
  .openapi({ description: 'The playbook name: `<upstream>-<prompt>`, or a pack’s own name for one it wrote.' })

export const routes = {
  playbooks: createRoute({
    method: 'get',
    path: PLAYBOOKS_PATH,
    operationId: 'listPlaybooks',
    tags: [TAG],
    summary: 'Playbooks',
    description:
      'Playbooks: a ready-made way to do one task. They are the prompts the upstreams you may use offer and, for a pack key, the playbooks written for its pack, which come first. Search with `q` (what you want to do), among the playbooks you may read: a pack key searches only its pack’s.',
    request: {
      query: z.object({
        q: z.string().max(200).optional().openapi({ description: 'What you want to do.', example: 'plan a dinner' }),
        upstream: z.string().max(40).optional().openapi({
          description: 'Only this upstream: a pack’s own playbooks, which belong to no upstream, are then left out.',
        }),
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
    request: { params: z.object({ name: playbookName }) },
    responses: { 200: ok('The playbook.', PlaybookSchema), ...problemResponses(401, 403, 404) },
  }),
  messages: createRoute({
    method: 'get',
    path: `${PLAYBOOKS_PATH}/{name}/messages`,
    operationId: 'getPlaybookMessages',
    tags: [TAG],
    summary: 'Use a playbook',
    description:
      'A playbook filled in with your arguments: the steps to follow with its tools, as its upstream wrote them or, for a pack’s own, as the pack wrote them with its variables filled in. Logged like a call.',
    request: {
      params: z.object({ name: playbookName }),
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
      'The resource templates and listed resources of the upstreams you may use: the links their tools return, which GET /api/resources?uri=… reads. Empty for a pack key, which opens only the links its tools returned in the last day.',
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
      'Reads a link an upstream serves, as a tool returned it (`cookbook://recipes/123`), with the upstream’s credential. `gateway://u/<upstream>/manual` is its manual, and `skill://<pack>/SKILL.md` is the skill of the pack a request is locked to (`pack.skill` on GET /api/me). Logged like a call.',
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
