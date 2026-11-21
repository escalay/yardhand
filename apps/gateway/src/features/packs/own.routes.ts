/**
 * Routes for what is written for a pack (owner only): its own playbooks and its one skill, as Markdown, and a check
 * of a draft that saves nothing.
 */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'
import { PLAYBOOK_NAME } from './playbook.js'
import { FindingSchema, OwnPlaybookSchema, PATH, PackName, PackSkillSchema, TAG } from './routes.js'
import { PACK_DOC_SOURCES } from './schema.js'

const PLAYBOOK_EXAMPLE = [
  '---',
  'title: Say hello',
  'description: Greets a guest by name, from the desk.',
  'arguments:',
  '  - name: guest',
  '    description: Who to greet.',
  '    required: true',
  '---',
  '',
  '1. Run `greet_from_desk` with `to` set to {{guest}}.',
  '2. Say it back with `fixture.echo`.',
].join('\n')

const PlaybookName = z.string().regex(PLAYBOOK_NAME).openapi({
  description:
    'The playbook’s name in this pack: a lowercase letter, then lowercase letters, digits or `-`, 3 to 64 in all.',
  example: 'say-hello',
})
const Markdown = z.string().min(1).max(200_000)
const PlaybookMarkdown = Markdown.openapi({
  description:
    'The playbook as Markdown. Front matter (between `---` lines) may give `title`, `description` and `arguments` (each `name`, and optionally `description` and `required`). The text writes an argument or a variable of the pack as `{{name}}`, names the pack’s tools in backticks by the names the pack calls them, and numbers its steps. 60,000 characters at most.',
  example: PLAYBOOK_EXAMPLE,
})
const SkillMarkdown = Markdown.openapi({
  description:
    'The skill’s text as Markdown, in six `## ` sections: What it is for, Which tool for which job, Values already set, Playbooks, Gotchas, What it can’t do. It writes a variable of the pack as `{{name}}` and names the pack’s tools in backticks. Front matter and a first `# ` heading are the gateway’s to write (from the pack’s name, title and what it is for): sent ones are dropped. 60,000 characters at most.',
  example:
    '## What it is for\n\nGreeting guests at {{door}}.\n\n## Which tool for which job\n\n`greet_from_desk` greets.',
})

const VersionSchema = z.object({
  id: z.string(),
  source: z.enum(PACK_DOC_SOURCES).openapi({
    description: 'Who wrote it: `owner` (through these routes), `ai` (a build) or `import` (a config import).',
  }),
  createdAt: z.string(),
  live: z.boolean().openapi({ description: 'The text the pack serves.' }),
})
const versions = z.array(VersionSchema).openapi({ description: 'Every text it had, newest first.' })
const version = z.string().openapi({ description: 'The version whose text `markdown` is.' })

const PlaybookDetailSchema = OwnPlaybookSchema.extend({
  markdown: z.string().openapi({ description: 'The text as written, front matter included.' }),
  version,
  versions,
  updatedAt: z.string(),
  _links: LinksSchema,
}).openapi('PackOwnPlaybookDetail', {
  description:
    'A playbook written for a pack, with its text and versions. With `?version=`, `markdown` and `version` are that older text; everything else describes the playbook as it is served.',
})
const PlaybookListSchema = z
  .object({
    count: z.number().int(),
    _links: LinksSchema,
    _embedded: z.object({ playbooks: z.array(OwnPlaybookSchema) }),
  })
  .openapi('PackOwnPlaybookList', { description: 'The playbooks written for a pack, in the order they were made.' })

const SkillDetailSchema = PackSkillSchema.extend({
  markdown: z.string().openapi({ description: 'The text as stored: no front matter, no first heading.' }),
  served: z.string().openapi({
    description:
      '`SKILL.md` whole: the front matter and heading the gateway writes, then the text with the pack’s variables filled in.',
  }),
  version,
  versions,
  updatedAt: z.string(),
  _links: LinksSchema,
}).openapi('PackSkillDetail', {
  description:
    'The skill written for a pack, with its text and versions. With `?version=`, `markdown`, `served` and `version` are that older text.',
})

const CheckInputSchema = z
  .object({
    kind: z.enum(['playbook', 'skill']),
    name: PlaybookName.optional().openapi({
      description:
        'For a playbook: the name it has or will have. One the pack already has is checked as a new text for that playbook; left out, it is checked as a new playbook called `draft`.',
    }),
    markdown: Markdown.openapi({
      description: 'The text to check, as a save would take it.',
      example: PLAYBOOK_EXAMPLE,
    }),
  })
  .openapi('PackCheckInput', { description: 'A draft of a playbook or of the skill.' })
const CheckSchema = z
  .object({
    findings: z.array(FindingSchema).openapi({
      description: 'What the checks find in the draft. A save is refused while one of them is an `error`.',
    }),
    _links: LinksSchema,
  })
  .openapi('PackCheck', { description: 'What a save of this draft would say. Nothing was saved.' })

const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({
  content: { [HAL_JSON]: { schema } },
  description,
})
const json = <Schema extends z.ZodTypeAny>(schema: Schema) => ({
  required: true,
  content: { 'application/json': { schema } },
})
const name = PackName.openapi({ param: { name: 'name', in: 'path' } })
const playbook = PlaybookName.openapi({ param: { name: 'playbook', in: 'path' } })
const older = z.object({
  version: z.string().max(80).optional().openapi({
    description: 'Read an older text: a version’s id, as `versions` lists them.',
    example: 'pdv_0123456789abcdef',
  }),
})
const CHECKS =
  'The text is checked first, and refused (400) with everything wrong in it: a tool named in backticks that is not in the pack, or by its own name where the pack gives it another; a `{{word}}` that is neither an argument nor a variable of the pack; front matter that can’t be read. Warnings come back in `findings` and never block: a tool a read-only key can’t run, a name that looks like a tool and is none, a `{{…}}` that is not written as a name, more than about 12 steps.'

export const ownRoutes = {
  listPlaybooks: createRoute({
    method: 'get',
    path: `${PATH}/{name}/playbooks`,
    operationId: 'listPackPlaybooks',
    tags: [TAG],
    summary: 'A pack’s own playbooks',
    description:
      'The playbooks written for this pack, each with what the checks find in it and a flag when a tool it was written for has changed or left the pack. The playbooks the pack holds from its connections are on the pack itself.',
    request: { params: z.object({ name }) },
    responses: { 200: ok('The playbooks.', PlaybookListSchema), ...problemResponses(401, 403, 404) },
  }),
  createPlaybook: createRoute({
    method: 'post',
    path: `${PATH}/{name}/playbooks`,
    operationId: 'createPackPlaybook',
    tags: [TAG],
    summary: 'Write a playbook for a pack',
    description: `A new playbook of the pack’s own, as Markdown. ${CHECKS} A name the pack already has a playbook under is a 409: \`PUT\` replaces its text.`,
    request: {
      params: z.object({ name }),
      body: json(
        z
          .object({ name: PlaybookName, markdown: PlaybookMarkdown })
          .openapi('PackPlaybookInput', { description: 'A new playbook for a pack.' }),
      ),
    },
    responses: { 201: ok('The playbook.', PlaybookDetailSchema), ...problemResponses(400, 401, 403, 404, 409) },
  }),
  getPlaybook: createRoute({
    method: 'get',
    path: `${PATH}/{name}/playbooks/{playbook}`,
    operationId: 'getPackPlaybook',
    tags: [TAG],
    summary: 'One of a pack’s own playbooks',
    description:
      'The playbook with its text as written, what the checks find in it, its flag and every version it had. `?version=<id>` reads an older text.',
    request: { params: z.object({ name, playbook }), query: older },
    responses: { 200: ok('The playbook.', PlaybookDetailSchema), ...problemResponses(401, 403, 404) },
  }),
  setPlaybook: createRoute({
    method: 'put',
    path: `${PATH}/{name}/playbooks/{playbook}`,
    operationId: 'setPackPlaybook',
    tags: [TAG],
    summary: 'Replace a pack playbook’s text',
    description: `Saves a new text for one of the pack’s own playbooks; the text it had is kept as a version. ${CHECKS} Saving the text it already has adds no version and clears its flag: it now stands on the tools as they are.`,
    request: {
      params: z.object({ name, playbook }),
      body: json(
        z
          .object({ markdown: PlaybookMarkdown })
          .openapi('PackPlaybookText', { description: 'A playbook’s text from now on.' }),
      ),
    },
    responses: { 200: ok('The playbook.', PlaybookDetailSchema), ...problemResponses(400, 401, 403, 404) },
  }),
  removePlaybook: createRoute({
    method: 'delete',
    path: `${PATH}/{name}/playbooks/{playbook}`,
    operationId: 'deletePackPlaybook',
    tags: [TAG],
    summary: 'Remove a pack playbook',
    description: 'Removes one of the pack’s own playbooks with every version of it.',
    request: { params: z.object({ name, playbook }) },
    responses: { 204: { description: 'Removed.' }, ...problemResponses(401, 403, 404) },
  }),
  getSkill: createRoute({
    method: 'get',
    path: `${PATH}/{name}/skill`,
    operationId: 'getPackSkill',
    tags: [TAG],
    summary: 'A pack’s skill',
    description:
      'The skill written for the pack: its text as stored, `SKILL.md` whole as it is read (front matter and heading from the pack, variables filled in), what the checks find, its flag and every version it had. 404 until one is written. `?version=<id>` reads an older text.',
    request: { params: z.object({ name }), query: older },
    responses: { 200: ok('The skill.', SkillDetailSchema), ...problemResponses(401, 403, 404) },
  }),
  setSkill: createRoute({
    method: 'put',
    path: `${PATH}/{name}/skill`,
    operationId: 'setPackSkill',
    tags: [TAG],
    summary: 'Write a pack’s skill',
    description:
      'Saves the pack’s one skill, “Working with <title>”; the text it had is kept as a version. Front matter and a first `# ` heading are dropped from what is sent: the gateway writes both from the pack. The text is checked first, and refused (400) for a tool named in backticks that is not in the pack, or by its own name where the pack gives it another, and for a `{{word}}` that is no variable of the pack. Warnings never block: a section of the six that is missing, a tool a read-only key can’t run, a manual of the pack at the same skill address. Saving the text it already has adds no version and clears its flag.',
    request: {
      params: z.object({ name }),
      body: json(
        z.object({ markdown: SkillMarkdown }).openapi('PackSkillInput', { description: 'A pack’s skill from now on.' }),
      ),
    },
    responses: { 200: ok('The skill.', SkillDetailSchema), ...problemResponses(400, 401, 403, 404) },
  }),
  removeSkill: createRoute({
    method: 'delete',
    path: `${PATH}/{name}/skill`,
    operationId: 'deletePackSkill',
    tags: [TAG],
    summary: 'Remove a pack’s skill',
    description: 'Removes the pack’s skill with every version of it.',
    request: { params: z.object({ name }) },
    responses: { 204: { description: 'Removed.' }, ...problemResponses(401, 403, 404) },
  }),
  check: createRoute({
    method: 'post',
    path: `${PATH}/{name}/checks`,
    operationId: 'checkPackDraft',
    tags: [TAG],
    summary: 'Check a draft without saving it',
    description:
      'Runs the checks a save runs on a draft of a playbook or of the skill, against the pack as it is, and answers what they find. Nothing is saved, and no version is added.',
    request: { params: z.object({ name }), body: json(CheckInputSchema) },
    responses: { 200: ok('What the checks find.', CheckSchema), ...problemResponses(400, 401, 403, 404) },
  }),
}
