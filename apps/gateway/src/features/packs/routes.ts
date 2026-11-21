/**
 * Pack routes (owner only): curate packs, word their tools, see what a playbook uses, the wording to recheck, and a
 * pack's people: who it is shared with, and sharing it with one more.
 */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'
import { KEY_LIFETIMES } from '../clients/lifetimes.js'
import { ClientName, SurfaceSchema } from '../clients/routes.js'
import { APP_IDS, KEY_APPS } from '../clients/setup.js'
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
  ending: z.number().int().openapi({ description: 'People whose access ends within three days.' }),
  ended: z.number().int().openapi({
    description:
      'People whose access ended in the last 30 days: still listed under People, so it can be extended. `keys` and this are everyone `GET /api/packs/{name}/people` lists.',
  }),
  createdAt: z.string(),
  triedAt: z.string().nullable().openapi({
    description:
      'When the owner first searched as the pack (`GET /api/tools?pack=<name>&q=…`) while it listed a tool, or null.',
  }),
  lastCallAt: z.string().nullable().openapi({
    description:
      'The newest call in the log (90 days) by any key that opens the pack, or null. A key with several packs counts for each of them.',
  }),
  formerNames: z
    .array(
      z.object({
        name: z.string(),
        until: z.string().openapi({ description: 'When it stopped being the pack’s name.' }),
        people: z.number().int().openapi({
          description:
            'People listed (`GET /api/packs/{name}/people`) who last connected at this name: those whose access ended count too, since Extend brings their setup back.',
        }),
      }),
    )
    .openapi({
      description:
        'Names it used to have that still lead to it, newest first, each with how many of its people last connected there. `DELETE /api/packs/{name}/names/{former}` frees one.',
    }),
}).openapi('Pack', { description: 'A pack with everything in it, in order.' })

const PersonSchema = z
  .object({
    id: z
      .string()
      .openapi({ description: 'The client’s id: Extend and Revoke are `PATCH` and `DELETE /api/clients/{id}`.' }),
    name: z.string(),
    kind: z.enum(['key', 'oauth']),
    app: z.enum(APP_IDS).nullable().openapi({
      description: 'The app the key was made for, as said when sharing; null when not said.',
    }),
    scope: z.enum(['read', 'write']),
    createdAt: z.string(),
    expiresAt: z.string().nullable().openapi({ description: 'When its access ends, or null for until revoked.' }),
    ending: z.boolean().openapi({ description: 'Its access ends within three days.' }),
    ended: z.boolean().openapi({ description: 'Its access ended in the last 30 days: Extend brings it back.' }),
    lastCallAt: z.string().nullable().openapi({ description: 'Its newest call in the log (90 days), or null.' }),
    calls7d: z.number().int().openapi({
      description: 'Calls in the last 7 days. A key that opens several packs counts its calls in all of them.',
    }),
    otherPacks: z.array(z.string()).openapi({
      description: 'Other packs the same key opens: its end, an Extend and a revoke are theirs too.',
    }),
    oldAddress: z
      .object({
        name: z.string().openapi({ description: 'The old name: it connects at `/p/<name>/`.' }),
        lastAt: z.string().openapi({ description: 'When it was last noted there (noted at most hourly).' }),
      })
      .nullable()
      .openapi({ description: 'The old name of the pack it last connected by; null once it uses the name now.' }),
    _links: LinksSchema,
  })
  .openapi('Person', { description: 'Someone a pack is shared with: one client that opens it.' })

const PackPeopleSchema = z
  .object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ people: z.array(PersonSchema) }) })
  .openapi('PackPeople', {
    description: 'Everyone a pack is shared with: who can use it first, oldest first, then whose access ended.',
  })

const ShareInputSchema = z
  .object({
    name: ClientName.openapi({
      description: 'Who it is for, on one line; spaces around it are dropped. It opens the message.',
      example: 'Sam',
    }),
    app: z.enum(KEY_APPS).nullable().optional().openapi({
      description:
        'The app they will paste the key into; null or left out when not sure. claude.ai is not one: it signs in and takes no key.',
    }),
    scope: z.enum(['read', 'write']).default('read').openapi({
      description: '`write` lets them run the pack’s tools that change things.',
    }),
    expiresIn: z.enum(KEY_LIFETIMES).default('30d').openapi({
      description: 'How long it works: 8 hours, a day, 7 days, 30 days, or `never` for until revoked.',
    }),
  })
  .openapi('PackShare', { description: 'One person to share a pack with.' })

const SharedPackSchema = PersonSchema.extend({
  key: z.string().openapi({ description: 'Their API key. Shown once: store it now.' }),
  message: z.string().openapi({
    description:
      'Ready to send to the person: what the pack is, what they can do, until when, and the setup for their app with the key in it. Shown once.',
  }),
}).openapi('SharedPack', { description: 'The new person, with their key and the message to send them, this once.' })

const PackSetupSchema = z
  .object({
    pack: z.string(),
    title: z.string(),
    baseUrl: z.string().openapi({
      description: 'The pack’s own address: everything of it is under here.',
      example: 'https://gw.example.com/p/design',
    }),
    mcpUrl: z.string(),
    apiUrl: z.string(),
    docsUrl: z.string(),
    guideUrl: z.string().openapi({ description: 'The pack’s guide for agents (`llms.txt`).' }),
    keyPlaceholder: z.string().openapi({ description: 'What stands in for the key in every snippet.' }),
    surfaces: z.array(SurfaceSchema),
    _links: LinksSchema,
  })
  .openapi('PackSetup', {
    description:
      'Where a pack is reached and paste-ready setup for every place a key of it can run. Never holds a key.',
  })

const PackListSchema = z
  .object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ packs: z.array(PackCardSchema) }) })
  .openapi('PackList', { description: 'Every pack, by title.' })

const PackInputSchema = z
  .object({
    name: PackName,
    title: z.string().min(1).max(80).openapi({ example: 'Design' }),
    description: z.string().max(4000).default('').openapi({
      description:
        'What the pack is for, as agents read it: it opens the instructions, guide and docs of the pack’s own connection.',
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
    name: PackName.optional().openapi({
      description:
        'A new name: the pack’s address becomes `/p/<name>/`. If it has a key that is not revoked when it is renamed, the old name keeps leading to it until you free it (`DELETE /api/packs/{name}/names/{former}`) or remove the pack.',
    }),
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
  setup: createRoute({
    method: 'get',
    path: `${PATH}/{name}/setup`,
    operationId: 'getPackSetup',
    tags: [TAG],
    summary: 'How to connect to a pack',
    description:
      'The pack’s own address (`/p/<name>/`: MCP, REST, docs and guide under it) and paste-ready setup for Claude Code, Cursor, Codex, curl and TypeScript, with `<YOUR_KEY>` where a key of the pack goes (owner only). A pack’s address takes keys only, so there is no claude.ai setup.',
    request: { params: z.object({ name }) },
    responses: { 200: ok('The setup.', PackSetupSchema), ...problemResponses(401, 403, 404) },
  }),
  update: createRoute({
    method: 'patch',
    path: `${PATH}/{name}`,
    operationId: 'updatePack',
    tags: [TAG],
    summary: 'Change a pack',
    description:
      'Changes its name, its title, what it is for, and adds or removes tools, playbooks and manuals. A new name moves its address; if the pack has a key that is not revoked then, the old name keeps leading to it until you free it (`DELETE /api/packs/{name}/names/{former}`) or remove the pack. A name another pack has, or that still leads to one, is a 409.',
    request: { params: z.object({ name }), body: json(PackPatchSchema) },
    responses: { 200: ok('The pack.', PackSchema), ...problemResponses(400, 401, 403, 404, 409) },
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
  freeName: createRoute({
    method: 'delete',
    path: `${PATH}/{name}/names/{former}`,
    operationId: 'freePackName',
    tags: [TAG],
    summary: 'Stop an old name leading here',
    description:
      'Frees a name the pack used to have: anyone still connecting at `/p/<former>/` is refused from now on, and another pack can take the name.',
    request: {
      params: z.object({
        name,
        former: PackName.openapi({
          param: { name: 'former', in: 'path' },
          description: 'The old name, as the pack’s `formerNames` lists it.',
        }),
      }),
    },
    responses: { 204: { description: 'Freed.' }, ...problemResponses(401, 403, 404) },
  }),
  people: createRoute({
    method: 'get',
    path: `${PATH}/{name}/people`,
    operationId: 'listPackPeople',
    tags: [TAG],
    summary: 'A pack’s people',
    description:
      'Everyone the pack is shared with, one row per client that opens it: the app they connect with, what they can do, when it ends, their last call and their calls in 7 days, and the old address they still use after a rename. Someone whose access ended stays listed for 30 days, to be extended (`PATCH /api/clients/{id}` with `expiresIn`); a revoked key is not listed.',
    request: { params: z.object({ name }) },
    responses: { 200: ok('The people.', PackPeopleSchema), ...problemResponses(401, 403, 404) },
  }),
  share: createRoute({
    method: 'post',
    path: `${PATH}/{name}/people`,
    operationId: 'sharePack',
    tags: [TAG],
    summary: 'Share a pack with a person',
    description:
      'Makes one person’s key for this pack alone, read only and for 30 days unless said, and answers with a message ready to send them: what the pack is, what they can do, until when, and the setup for their app with the key in it, at the address set in `PUBLIC_HOST` (unset, or naming only this machine as `localhost` does, the address this request came by). The key and the message are shown this once. Sent with an `Idempotency-Key`, the same request sent again within a day is answered the same key and message, not a second person: that answer is kept sealed with the master key. Extend and Revoke are the client’s own routes (`PATCH` and `DELETE /api/clients/{id}`). A pack that holds no tools is a 409.',
    request: { params: z.object({ name }), body: json(ShareInputSchema) },
    responses: {
      201: ok('The person, their key and the message.', SharedPackSchema),
      ...problemResponses(400, 401, 403, 404, 409),
    },
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
