/**
 * Pack routes (owner only): curate packs, word their tools, set their inputs and the pack's variables, see what a
 * playbook uses, what to recheck, and a pack's people: who it is shared with, and sharing it with one more.
 */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'
import { KEY_LIFETIMES } from '../clients/lifetimes.js'
import { ClientName, SurfaceSchema } from '../clients/routes.js'
import { APP_IDS, KEY_APPS } from '../clients/setup.js'
import { ALIAS } from './entries.js'
import { PACK_REASONS } from './schema.js'
import { VARIABLE_DESCRIPTION_MAX, VARIABLES_MAX } from './values.js'

export const PATH = '/api/packs'
export const FLAGS_PATH = '/api/packs/flags'
export const TAG = 'Packs'

export const PackName = z
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
const DefaultsSchema = z.record(z.string(), z.unknown()).openapi({
  description:
    'Inputs the gateway fills when a call leaves them out, by input name. The pack’s keys read each with this value as its default and may send their own.',
  example: { posted_since: '{{since_days}}' },
})
const VariableValue = z.union([z.string().max(4000), z.number(), z.boolean()]).openapi({
  description: 'A string, a number or true/false. A value that is `{{name}}` and nothing else takes it with its type.',
  example: 7,
})
const VariableSchema = z
  .object({
    name: z.string().openapi({ description: 'Written `{{name}}` in a fixed or default value.', example: 'since_days' }),
    value: VariableValue,
    description: z.string().nullable().openapi({ description: 'What it is for, for whoever edits the pack.' }),
    usedBy: z
      .array(z.string())
      .openapi({ description: 'The pack’s tools whose values write it, by the pack’s names.' }),
  })
  .openapi('PackVariable', { description: 'A named value of a pack, written `{{name}}` where a tool’s input uses it.' })
export const FindingSchema = z
  .object({
    level: z.enum(['error', 'warning']).openapi({
      description:
        '`error`: calls that use the value can fail (a tool input’s `problem` says which), or a text names something that is not there; a save that sends it is refused. `warning`: worth a look; nothing fails.',
    }),
    code: z.string().openapi({
      description:
        'In a tool’s values and the variables: `unknown_input`, `bad_value`, `two_modes`, `bad_variable_name`, `duplicate_variable`, `variable_in_use`, or a warning: `not_a_variable`, `not_checked`, `unused_variable`, `not_live`. In a playbook or the skill: `not_in_pack`, `use_alias`, `left_pack`, `unresolved`, `name_clash`, `bad_name`, `bad_front_matter`, `bad_argument_name`, `empty`, `too_big`, or a warning: `unknown_name`, `not_a_name`, `needs_write`, `split`, `missing_section`, `skill_path`.',
      example: 'bad_value',
    }),
    path: z.string().openapi({
      description:
        'Where: `tools.<name>.fixed.<input>`, `tools.<name>.defaults.<input>`, `variables.<name>`, `playbooks.<name>` (one of the pack’s own) or `skill`.',
      example: 'tools.greet_from_desk.fixed.from',
    }),
    message: z.string(),
  })
  .openapi('PackFinding', { description: 'Something the checks found in a pack.' })
const ToolInputSchema = z
  .object({
    name: z.string(),
    mode: z.enum(['fixed', 'default', 'agent']).openapi({
      description:
        '`fixed`: the pack fills it on every call and hides it. `default`: shown with the pack’s value, which a call may replace. `agent`: the agent fills it.',
    }),
    value: z.unknown().openapi({ description: 'The pack’s value as written (`{{name}}` kept), or null.' }),
    resolved: z.unknown().openapi({ description: 'The value with the pack’s variables filled in, or null.' }),
    required: z.boolean().openapi({ description: 'The tool itself requires it.' }),
    problem: z.string().nullable().openapi({
      description:
        'Why the value no longer fits the live tool, or null. Until it is changed, a fixed value fails every call and a default fails the calls that leave the input out.',
    }),
    note: z.string().nullable().openapi({
      description: 'Worth a look, or null: a `{{word}}` that is no variable of the pack is sent as written.',
    }),
    unchecked: z.boolean().openapi({
      description:
        'The pack sets a value here that was not checked: the gateway can’t read this input’s schema, so only a call checks it.',
    }),
  })
  .openapi('PackToolInput', { description: 'One input of a pack tool and who fills it.' })
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
    defaults: DefaultsSchema,
    inputs: z.array(ToolInputSchema).openapi({
      description: 'Every input of the live tool, in its order, with who fills it. Empty when the tool is not live.',
    }),
    lostInputs: z.array(z.string()).openapi({
      description:
        'Inputs the pack fixes or defaults that the live tool no longer takes: the upstream dropped or renamed them. Set them again or drop them.',
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

export const DocFlagSchema = z
  .object({
    was: z.string().openapi({
      description: 'The tools it was written for that have since moved, by the names the pack called them.',
      example: 'written for greet_from_desk',
    }),
    now: z.string().openapi({
      description: 'What happened to each: it left the pack, it is not live, or its server changed it.',
      example: 'greet_from_desk is no longer in Front desk',
    }),
  })
  .openapi('PackDocFlag', {
    description:
      'A tool this text was written for has changed or left the pack: read the text again. Saving it, changed or not, clears the flag, and is refused while it still names a tool the pack no longer has.',
  })

const ArgumentSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  required: z.boolean(),
})
export const OwnPlaybookSchema = z
  .object({
    name: z.string(),
    title: z.string().openapi({ description: 'From the front matter, else made from the name.' }),
    description: z.string(),
    arguments: z.array(ArgumentSchema).openapi({ description: 'What an agent fills, written `{{name}}` in the text.' }),
    steps: z.number().int().openapi({ description: 'The numbered steps in the text.' }),
    flag: DocFlagSchema.nullable(),
    findings: z.array(FindingSchema).openapi({ description: 'What the checks find in this playbook as it stands.' }),
  })
  .openapi('PackOwnPlaybook', { description: 'A playbook written for a pack.' })

export const PackSkillSchema = z
  .object({
    uri: z.string().openapi({ description: 'Where the skill sits.', example: 'skill://desk/SKILL.md' }),
    sections: z.array(z.string()).openapi({ description: 'Which of the six sections the text has.' }),
    flag: DocFlagSchema.nullable(),
    findings: z.array(FindingSchema).openapi({ description: 'What the checks find in the skill as it stands.' }),
  })
  .openapi('PackSkill', { description: 'The skill written for a pack.' })
const PackKeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    scope: z.enum(['read', 'write']),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('PackKey', { description: 'A live key locked to the pack.' })

const counts = z.object({
  tools: z.number().int(),
  playbooks: z.number().int().openapi({ description: 'Playbooks it holds from its connections.' }),
  manuals: z.number().int(),
  ownPlaybooks: z.number().int().openapi({ description: 'Playbooks written for it.' }),
})

const PackCardSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    description: z.string(),
    counts,
    upstreams: z.array(z.string()),
    keys: z.number().int().openapi({ description: 'Live keys locked to it.' }),
    flags: z.number().int().openapi({
      description:
        'What to recheck: tools whose wording their upstream rewrote or with a fixed or default value that no longer fits, and playbooks of its own, or its skill, written for a tool that has changed or left the pack.',
    }),
    updatedAt: z.string(),
    _links: LinksSchema,
  })
  .openapi('PackCard', { description: 'A pack on the board.' })

export const PackSchema = PackCardSchema.extend({
  tools: z.array(PackToolSchema),
  variables: z.array(VariableSchema),
  findings: z.array(FindingSchema).openapi({
    description: 'What the checks find in the pack as it stands: errors to fix, and warnings.',
  }),
  playbooks: z.array(PackItemSchema).openapi({ description: 'The playbooks it holds from its connections.' }),
  manuals: z.array(PackItemSchema),
  ownPlaybooks: z.array(OwnPlaybookSchema).openapi({
    description:
      'The playbooks written for it, in the order they were made. Their text is at `GET /api/packs/{name}/playbooks/{playbook}`.',
  }),
  skill: PackSkillSchema.nullable().openapi({
    description: 'The skill written for it, or null. Its text is at `GET /api/packs/{name}/skill`.',
  }),
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
  build: z
    .object({ id: z.string(), status: z.enum(['running', 'ready', 'stopped']) })
    .nullable()
    .openapi({
      description:
        'Its newest Build or Refresh with AI while it runs or waits to be accepted, or null. `GET /api/packs/{name}/builds/{id}` reads it.',
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
  defaults: DefaultsSchema.optional(),
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
          'What to add, at the end; anything already in stays as it is. A tool goes in under its alias when it has one, so the same tool can go in again under another alias (with other fixed inputs or defaults). An alias can’t be the name of one of a connection’s own tools (`search_tools`, `call_tool` and the rest).',
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
    defaults: DefaultsSchema.nullable().optional().openapi({
      description:
        'What it gives a default from now on (replaces its defaults); null or {} gives none. An input is fixed or has a default, never both.',
    }),
  })
  .openapi('PackEntryInput', { description: 'How one pack tool is named and which inputs the pack sets.' })

const VariablesInputSchema = z
  .object({
    variables: z
      .array(
        z.object({
          name: z.string().min(1).max(80).openapi({
            description: 'A lowercase letter, then lowercase letters, digits or `_`, 40 at most.',
            example: 'since_days',
          }),
          value: VariableValue,
          description: z.string().max(VARIABLE_DESCRIPTION_MAX).nullable().optional(),
        }),
      )
      .max(VARIABLES_MAX),
  })
  .openapi('PackVariablesInput', {
    description: 'The pack’s variables from now on, in order: this list replaces the one it had.',
    example: { variables: [{ name: 'since_days', value: 7, description: 'How far back a search looks.' }] },
  })

const PackFlagSchema = z
  .object({
    kind: z.enum(['wording', 'input', 'playbook', 'skill']).openapi({
      description:
        '`wording`: the upstream rewrote the tool. `input`: the tool no longer takes an input the pack fixes or defaults, or no longer takes its value. `playbook`, `skill`: one of the pack’s own playbooks, or its skill, was written for a tool that has since changed or left the pack.',
    }),
    pack: z.string(),
    packTitle: z.string(),
    tool: z.string().openapi({
      description:
        'The name the pack calls it. For `playbook` and `skill`: the first name the text was written for that has moved, which may no longer be in the pack.',
    }),
    item: z.string().nullable().openapi({
      description: 'For `playbook`: the playbook’s name. For `skill`: `SKILL.md`. Null for a tool’s own flags.',
    }),
    wording: z.string().openapi({ description: 'The pack’s wording of the tool; empty for `playbook` and `skill`.' }),
    was: z.string().openapi({
      description:
        '`wording`: the upstream’s description when the wording was written. `input`: what the pack sets, e.g. `fixes from` or `defaults from`. `playbook`, `skill`: the names it was written for that have moved, e.g. `written for greet_from_desk`.',
    }),
    now: z.string().openapi({
      description:
        '`wording`: the upstream’s description now. `input`: what is wrong with it now. `playbook`, `skill`: what happened to each name.',
    }),
    _links: LinksSchema,
  })
  .openapi('PackFlag', {
    description:
      'Something in a pack to recheck because a tool changed under it. `_links.tool` is left out for a `playbook` or `skill` whose name no longer leads to a tool.',
  })
const PackFlagListSchema = z
  .object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ flags: z.array(PackFlagSchema) }) })
  .openapi('PackFlagList', { description: 'Everything in the packs to recheck.' })

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
    summary: 'What to recheck in the packs',
    description:
      'Every pack wording whose tool its upstream has since rewritten (old and new text), every tool with a fixed or default value its live tool no longer takes (the input is gone, or the value no longer fits it), and every playbook or skill written for a pack whose tools have since changed or left it.',
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
    description:
      'A pack with its tools (wording, why each is in, who fills each input, flags), variables, the playbooks and manuals it holds from its connections, the playbooks and skill written for it, its keys, and what the checks find in it.',
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
      'Changes its name, its title, what it is for, and adds or removes tools, playbooks and manuals. A new name moves its address; if the pack has a key that is not revoked then, the old name keeps leading to it until you free it (`DELETE /api/packs/{name}/names/{former}`) or remove the pack. A name another pack has, or that still leads to one, is a 409. A tool can go in with fixed inputs and defaults: they are checked against its live input schema, and a problem the pack already had elsewhere never blocks the change. Removing a tool that one of the pack’s own playbooks or its skill names goes through: the text is flagged and listed in `findings` until it is saved again. A connection’s playbook named like one of the pack’s own is refused (400). A change that is refused leaves the pack, and its name, as they were.',
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
    summary: 'Rename a pack tool or set its inputs',
    description:
      'Gives one of the pack’s tools its own name (an alias) and sets its inputs: `fixed` are filled on every call and never shown to the pack’s keys, `defaults` are shown with the pack’s value and filled when a call leaves them out, and every other input is the agent’s. A value may write a variable of the pack as `{{name}}`. Only the maps sent are checked, against the live tool’s input schema with the variables filled in. A new name never fails on a playbook or the skill that writes the old one: the text is flagged, and the pack’s `findings` say where.',
    request: { params: z.object({ name, tool: entryParam }), body: json(EntryInputSchema) },
    responses: { 200: ok('The tool in the pack.', PackToolSchema), ...problemResponses(400, 401, 403, 404, 409) },
  }),
  variables: createRoute({
    method: 'put',
    path: `${PATH}/{name}/variables`,
    operationId: 'setPackVariables',
    tags: [TAG],
    summary: 'Set a pack’s variables',
    description:
      'Replaces the pack’s variables. A fixed or default value writes one as `{{name}}`, and so do the pack’s own playbooks and its skill; in a value, a `{{word}}` that is no variable of the pack is sent as written. Refused (400) when a name is bad or repeated, when a new value no longer fits an input that uses it, or when a variable left out is still written by a value, a playbook or the skill.',
    request: { params: z.object({ name }), body: json(VariablesInputSchema) },
    responses: { 200: ok('The pack.', PackSchema), ...problemResponses(400, 401, 403, 404) },
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
