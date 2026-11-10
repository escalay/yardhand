/** Pack routes (owner only): curate packs, word their tools, see what a playbook uses, and the wording to recheck. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'
import { ALIAS } from './entries.js'
import { PACK_REASONS } from './schema.js'

export const PATH = '/api/packs'
export const FLAGS_PATH = '/api/packs/flags'
export const TAG = 'Packs'

const PackName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
  .refine((name) => name !== 'flags', 'flags is taken')
  .openapi({ description: 'The pack’s name: lowercase letters, digits and dashes.', example: 'design' })
const ToolName = z.string().min(3).max(160)
const Alias = z.string().regex(ALIAS).openapi({
  description:
    'What the pack’s keys call the tool instead of `<upstream>.<tool>`: lowercase words joined by `_` or `-`, e.g. `team_inbox_search`.',
  example: 'team_inbox_search',
})
const FixedSchema = z.record(z.string(), z.unknown()).openapi({
  description:
    'Inputs the gateway fills on every call, by input name. They leave the schema the pack’s keys read, and a call that sends one is refused.',
  example: { account: 'Acme Work Email' },
})
const EntryName = z.string().min(2).max(160)
const ItemName = z.string().min(1).max(160)

const FlagSchema = z
  .object({
    was: z.string().openapi({ description: 'The upstream’s description when the wording was written.' }),
    now: z.string().openapi({ description: 'The upstream’s description now.' }),
  })
  .openapi('WordingFlag', { description: 'The upstream rewrote a tool this pack words: keep or rewrite the wording.' })

export const PackToolSchema = z
  .object({
    name: z.string().openapi({ description: 'What the pack’s keys call it: its alias, else the tool’s own name.' }),
    tool: z.string().openapi({ description: 'The tool it runs, `<upstream>.<tool>`.' }),
    alias: z.string().nullable().openapi({ description: 'The pack’s own name for it, or null.' }),
    fixed: FixedSchema,
    lostInputs: z.array(z.string()).openapi({
      description:
        'Fixed inputs the live tool no longer takes: the upstream dropped or renamed them. Fix or drop them.',
    }),
    upstream: z.string(),
    title: z.string().nullable(),
    description: z.string().openapi({ description: 'What the pack’s keys read: its wording, else the upstream’s.' }),
    upstreamDescription: z.string().nullable().openapi({ description: 'The upstream’s own description (live).' }),
    wording: z.string().nullable().openapi({ description: 'The pack’s own description, or null.' }),
    reason: z.enum(PACK_REASONS).openapi({
      description: 'Why it is in: picked, named in a playbook, by a playbook’s route, or by meaning (confirmed).',
    }),
    via: z.string().nullable().openapi({ description: 'The playbook that brought it in.' }),
    needsWrite: z.boolean(),
    live: z.boolean().openapi({ description: 'False when the tool is gone or not live: the pack keeps the place.' }),
    flag: FlagSchema.nullable(),
  })
  .openapi('PackTool', { description: 'One tool in a pack.' })

const PackItemSchema = z
  .object({
    name: z.string(),
    upstream: z.string().nullable(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    live: z.boolean(),
  })
  .openapi('PackItem', { description: 'A playbook or manual in a pack.' })

const PackKeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    scope: z.enum(['read', 'write']),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('PackKey', { description: 'A live key locked to the pack.' })

const counts = z.object({ tools: z.number().int(), playbooks: z.number().int(), manuals: z.number().int() })

const PackCardSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    description: z.string(),
    counts,
    upstreams: z.array(z.string()),
    keys: z.number().int().openapi({ description: 'Live keys locked to it.' }),
    flags: z.number().int().openapi({ description: 'Tools whose wording or fixed inputs to recheck.' }),
    updatedAt: z.string(),
    _links: LinksSchema,
  })
  .openapi('PackCard', { description: 'A pack on the board.' })

export const PackSchema = PackCardSchema.extend({
  tools: z.array(PackToolSchema),
  playbooks: z.array(PackItemSchema),
  manuals: z.array(PackItemSchema),
  keyList: z.array(PackKeySchema),
  createdAt: z.string(),
}).openapi('Pack', { description: 'A pack with everything in it, in order.' })

const PackListSchema = z
  .object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ packs: z.array(PackCardSchema) }) })
  .openapi('PackList', { description: 'Every pack, by title.' })

const PackInputSchema = z
  .object({
    name: PackName,
    title: z.string().min(1).max(80).openapi({ example: 'Design' }),
    description: z.string().max(4000).default('').openapi({
      description: 'What the pack is for, as agents read it: it becomes the server instructions for its keys.',
    }),
    playbook: ItemName.optional().openapi({
      description: 'Start from this playbook: it, the tools it names or calls, and its server’s manual go in.',
      example: 'cookbook-plan-a-dinner',
    }),
  })
  .openapi('PackInput', { description: 'A new pack.' })

const AddToolSchema = z.object({
  name: ToolName.openapi({ description: 'The tool, `<upstream>.<tool>`.' }),
  reason: z.enum(PACK_REASONS).default('picked'),
  via: ItemName.nullable().optional(),
  alias: Alias.nullable().optional(),
  fixed: FixedSchema.optional(),
})
const PackPatchSchema = z
  .object({
    title: z.string().min(1).max(80).optional(),
    description: z.string().max(4000).optional(),
    add: z
      .object({
        tools: z.array(AddToolSchema).max(200).optional(),
        playbooks: z.array(ItemName).max(50).optional(),
        manuals: z.array(ItemName).max(50).optional(),
      })
      .optional()
      .openapi({
        description:
          'What to add, at the end; anything already in stays as it is. A tool goes in under its alias when it has one, so the same tool can go in again under another alias (with other fixed inputs).',
      }),
    remove: z
      .object({
        tools: z.array(EntryName).max(200).optional().openapi({ description: 'By the names the pack calls them.' }),
        playbooks: z.array(ItemName).max(50).optional(),
        manuals: z.array(ItemName).max(50).optional(),
      })
      .optional(),
  })
  .openapi('PackPatch', { description: 'Changes to a pack.' })

const WordingInputSchema = z
  .object({
    description: z.string().min(1).max(8000).nullable().openapi({
      description: 'The pack’s description of the tool, or null for the upstream’s. Saving it clears its flag.',
    }),
  })
  .openapi('WordingInput', { description: 'A tool’s wording in one pack.' })

const EntryInputSchema = z
  .object({
    alias: Alias.nullable()
      .optional()
      .openapi({ description: 'A new name for it in this pack; null for the tool’s own.' }),
    fixed: FixedSchema.nullable().optional().openapi({
      description: 'What it fixes from now on (replaces what it fixed); null or {} fixes nothing.',
    }),
  })
  .openapi('PackEntryInput', { description: 'How one pack tool is named and what it fixes.' })

const PackFlagSchema = z
  .object({
    kind: z.enum(['wording', 'input']).openapi({
      description:
        '`wording`: the upstream rewrote the tool. `input`: the tool no longer takes an input the pack fixes.',
    }),
    pack: z.string(),
    packTitle: z.string(),
    tool: z.string().openapi({ description: 'The name the pack calls it.' }),
    wording: z.string(),
    was: z.string(),
    now: z.string(),
    _links: LinksSchema,
  })
  .openapi('PackFlag', { description: 'Something in a pack to recheck because its upstream changed the tool.' })
const PackFlagListSchema = z
  .object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ flags: z.array(PackFlagSchema) }) })
  .openapi('PackFlagList', { description: 'Every pack tool to recheck.' })

const UseSchema = z
  .object({
    tool: z.string(),
    reason: z.enum(['named', 'route', 'meaning']).openapi({
      description: '`named` and `route` are certain (the text names it or calls its route); `meaning` is a guess.',
    }),
    title: z.string().nullable(),
    summary: z.string(),
    inPack: z.boolean().openapi({ description: 'Already in the pack asked about.' }),
  })
  .openapi('PlaybookUse', { description: 'A tool a playbook uses.' })
const UsesSchema = z
  .object({
    playbook: z.string(),
    upstream: z.string(),
    textRead: z.boolean().openapi({ description: 'False when the playbook’s text could not be read: only meaning.' }),
    manual: z.string().nullable().openapi({ description: 'Its server’s manual, to go in with it.' }),
    uses: z.array(UseSchema),
    _links: LinksSchema,
  })
  .openapi('PlaybookUses', { description: 'The tools a playbook uses, certain first, then likely by meaning.' })

const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({
  content: { [HAL_JSON]: { schema } },
  description,
})
const json = <Schema extends z.ZodTypeAny>(schema: Schema) => ({
  required: true,
  content: { 'application/json': { schema } },
})
const name = PackName.openapi({ param: { name: 'name', in: 'path' } })
const entryParam = EntryName.openapi({
  param: { name: 'tool', in: 'path' },
  description: 'The name the pack calls it: its alias, else `<upstream>.<tool>`.',
})

export const routes = {
  flags: createRoute({
    method: 'get',
    path: FLAGS_PATH,
    operationId: 'listPackFlags',
    tags: [TAG],
    summary: 'Pack tools to recheck',
    description:
      'Every pack wording whose tool its upstream has since rewritten (old and new text), and every fixed input the tool no longer takes.',
    responses: { 200: ok('The flags.', PackFlagListSchema), ...problemResponses(401, 403) },
  }),
  list: createRoute({
    method: 'get',
    path: PATH,
    operationId: 'listPacks',
    tags: [TAG],
    summary: 'Packs',
    description: 'Every pack: a curated kit of tools, playbooks and manuals that a key can be locked to.',
    responses: { 200: ok('Packs.', PackListSchema), ...problemResponses(401, 403) },
  }),
  create: createRoute({
    method: 'post',
    path: PATH,
    operationId: 'createPack',
    tags: [TAG],
    summary: 'Make a pack',
    description: 'A new pack, empty or started from a playbook (it, the tools it names or calls, its manual).',
    request: { body: json(PackInputSchema) },
    responses: { 201: ok('The new pack.', PackSchema), ...problemResponses(400, 401, 403, 409) },
  }),
  get: createRoute({
    method: 'get',
    path: `${PATH}/{name}`,
    operationId: 'getPack',
    tags: [TAG],
    summary: 'One pack',
    description: 'A pack with its tools (wording, why each is in, flags), playbooks, manuals and keys.',
    request: { params: z.object({ name }) },
    responses: { 200: ok('The pack.', PackSchema), ...problemResponses(401, 403, 404) },
  }),
  update: createRoute({
    method: 'patch',
    path: `${PATH}/{name}`,
    operationId: 'updatePack',
    tags: [TAG],
    summary: 'Change a pack',
    description: 'Renames it, rewrites what it is for, adds or removes tools, playbooks and manuals.',
    request: { params: z.object({ name }), body: json(PackPatchSchema) },
    responses: { 200: ok('The pack.', PackSchema), ...problemResponses(400, 401, 403, 404) },
  }),
  remove: createRoute({
    method: 'delete',
    path: `${PATH}/{name}`,
    operationId: 'deletePack',
    tags: [TAG],
    summary: 'Remove a pack',
    description: 'Removes a pack with no live keys (revoke them first).',
    request: { params: z.object({ name }) },
    responses: { 204: { description: 'Removed.' }, ...problemResponses(401, 403, 404, 409) },
  }),
  wording: createRoute({
    method: 'put',
    path: `${PATH}/{name}/tools/{tool}/wording`,
    operationId: 'setPackWording',
    tags: [TAG],
    summary: 'Word a tool',
    description:
      'The pack’s own description of one of its tools (null for the upstream’s). Saving the same text again keeps it after the upstream changed.',
    request: {
      params: z.object({ name, tool: entryParam }),
      body: json(WordingInputSchema),
    },
    responses: { 200: ok('The tool in the pack.', PackToolSchema), ...problemResponses(400, 401, 403, 404) },
  }),
  entry: createRoute({
    method: 'patch',
    path: `${PATH}/{name}/tools/{tool}`,
    operationId: 'updatePackTool',
    tags: [TAG],
    summary: 'Rename a pack tool or fix its inputs',
    description:
      'Gives one of the pack’s tools its own name (an alias) and sets the inputs the gateway fills on every call. Fixed values are checked against the live tool’s input schema; the pack’s keys never see them.',
    request: { params: z.object({ name, tool: entryParam }), body: json(EntryInputSchema) },
    responses: { 200: ok('The tool in the pack.', PackToolSchema), ...problemResponses(400, 401, 403, 404, 409) },
  }),
  uses: createRoute({
    method: 'get',
    path: '/api/playbooks/{name}/uses',
    operationId: 'getPlaybookUses',
    tags: [TAG],
    summary: 'What a playbook uses',
    description:
      'The tools a playbook names or calls by route (certain), then up to five likely by meaning, marked if already in `pack`.',
    request: {
      params: z.object({
        name: ItemName.openapi({ param: { name: 'name', in: 'path' }, description: 'The playbook name.' }),
      }),
      query: z.object({
        pack: PackName.optional().openapi({ description: 'Mark the tools already in this pack.' }),
      }),
    },
    responses: { 200: ok('Its uses.', UsesSchema), ...problemResponses(401, 403, 404) },
  }),
}
