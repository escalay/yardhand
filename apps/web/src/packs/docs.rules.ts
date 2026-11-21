/**
 * Pure rules for what is written for a pack, its own playbooks and its skill: a playbook's name from its title, the
 * text a new one starts from, what the checks found in words, what a flag asks of the owner, and each text's line on
 * the pack page. What a flag says in Reviews is `flagLine` in `packs.rules.ts`.
 */
import type { Schemas } from '@/api/client'
import { plural, when } from '@/ui/format'
import { stop } from './packs.rules'

type Pack = Schemas['Pack']
type Finding = Schemas['PackFinding']
type OwnPlaybook = Schemas['PackOwnPlaybook']
type Version = Schemas['PackOwnPlaybookDetail']['versions'][number]

/** A pack playbook's name as the gateway takes it (`features/packs/playbook.ts`). */
const PLAYBOOK_NAME = /^[a-z][a-z0-9-]{2,63}$/
export const isPlaybookName = (name: string) => PLAYBOOK_NAME.test(name)

/** `Say hello` → `say-hello`: a letter first, 64 at most, and nothing when fewer than three characters are left. */
export const playbookNameOf = (title: string) => {
  const name = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  return isPlaybookName(name) ? name : ''
}

/** What is wrong with a new playbook's name, or null: `own` are the pack's own, `held` the ones from connections. */
export const playbookNameProblem = (name: string, taken: { own: string[]; held: string[] }) =>
  name === ''
    ? 'Give it a name, like find-roles.'
    : !isPlaybookName(name)
      ? 'Start with a lowercase letter, then lowercase letters, digits or - (3 to 64), like find-roles.'
      : taken.own.includes(name)
        ? `${name} is already a playbook written for this pack: edit that one, or pick another name.`
        : taken.held.includes(name)
          ? `This pack already holds a playbook called ${name}, from a connection: give this one another name.`
          : null

/**
 * The text a new playbook starts from: front matter with one argument, and steps that write it. It names no tool,
 * so the checks pass it as it is; the title is quoted, whatever it holds.
 */
export const starterPlaybook = (title: string) =>
  [
    '---',
    `title: ${JSON.stringify(title.trim() || 'Untitled playbook')}`,
    'description: What this playbook gets done, in one sentence.',
    'arguments:',
    '  - name: topic',
    '    description: What to work on.',
    '    required: true',
    '---',
    '',
    '1. Start from {{topic}}: say in a line what you are about to do.',
    '2. Run the tool for the job. Name each tool in backticks, by the name this pack calls it.',
    '3. Say what came of it, and what is still open.',
    '',
  ].join('\n')

/** The six sections of a pack's skill, as the gateway looks for them (`features/packs/skill.ts`). */
export const SKILL_SECTIONS = [
  'What it is for',
  'Which tool for which job',
  'Values already set',
  'Playbooks',
  'Gotchas',
  "What it can't do",
] as const

/** A line of someone else's words, kept only when the checks would read nothing into it: no backtick, no `{{`. */
const plainLine = (text: string | null | undefined) => {
  const line = (text ?? '').split('\n')[0]?.trim() ?? ''
  return /`|\{\{/.test(line) ? '' : line
}

const item = (name: string, about: string) => (about ? `- \`${name}\`: ${about}` : `- \`${name}\``)

/**
 * The text a new skill starts from: the six sections, filled with what the pack already knows (what it is for, its
 * tools by the names it calls them, its variables and the inputs it fills, its playbooks). Only the pack's own
 * variables are written `{{name}}`, so the checks pass it as it is.
 */
export const starterSkill = (
  pack: Pick<Pack, 'title' | 'description' | 'variables'> & {
    tools: Pick<Pack['tools'][number], 'name' | 'wording' | 'upstreamDescription' | 'fixed' | 'defaults'>[]
    playbooks: Pick<Pack['playbooks'][number], 'name' | 'description'>[]
    ownPlaybooks: Pick<OwnPlaybook, 'name' | 'description'>[]
  },
) => {
  const about = pack.description.trim().split(/\n\s*\n/)[0] ?? ''
  const set = [
    ...pack.variables.map((variable) =>
      `- ${variable.name}: {{${variable.name}}}. ${plainLine(variable.description)}`.trimEnd(),
    ),
    ...pack.tools.flatMap((tool) => {
      const fixed = Object.keys(tool.fixed)
      const defaults = Object.keys(tool.defaults)
      return [
        ...(fixed.length
          ? [
              `- \`${tool.name}\` always sends ${fixed.join(', ')}: ${fixed.length === 1 ? 'it is' : 'they are'} not yours to fill.`,
            ]
          : []),
        ...(defaults.length
          ? [
              `- \`${tool.name}\` fills ${defaults.join(', ')} when you leave ${defaults.length === 1 ? 'it' : 'them'} out.`,
            ]
          : []),
      ]
    }),
  ]
  const playbooks = [...pack.ownPlaybooks, ...pack.playbooks].map((playbook) =>
    item(playbook.name, plainLine(playbook.description)),
  )
  const sections: Record<(typeof SKILL_SECTIONS)[number], string[]> = {
    'What it is for': [about || `Say what ${pack.title} is for, and when an agent should reach for it.`],
    'Which tool for which job': pack.tools.length
      ? pack.tools.map((tool) => item(tool.name, plainLine(tool.wording ?? tool.upstreamDescription)))
      : ['No tools yet.'],
    'Values already set': set.length ? set : ['Nothing is set for you: every input is yours to fill.'],
    Playbooks: playbooks.length ? playbooks : ['None yet.'],
    Gotchas: ['None noted yet.'],
    "What it can't do": ['Anything its tools don’t do: say so instead of working around it.'],
  }
  return SKILL_SECTIONS.map((section) => `## ${section}\n\n${sections[section].join('\n')}\n`).join('\n')
}

/** Findings with the errors first, each kind in the order the checks gave them. */
export const byLevel = (findings: Finding[]) => [
  ...findings.filter((finding) => finding.level === 'error'),
  ...findings.filter((finding) => finding.level === 'warning'),
]

/** What the checks found, summed up: the problems that refuse a save, then what is only worth a look. */
export const findingsLine = (findings: Finding[]) => {
  const errors = findings.filter((finding) => finding.level === 'error').length
  const warnings = findings.length - errors
  return [
    errors
      ? `${plural(errors, 'problem')} to fix before it can be saved`
      : '✓ Every tool named is in the pack and every {{…}} resolves',
    ...(warnings ? [`${plural(warnings, 'thing')} to look at`] : []),
  ].join(' · ')
}

/** One finding as a sentence. A playbook past its steps is said in the app's words, with the gateway's count. */
export const findingText = ({ code, message }: Pick<Finding, 'code' | 'message'>) => {
  const steps = code === 'split' ? /^(\d+) steps/.exec(message)?.[1] : undefined
  return steps
    ? `This playbook has ${steps} steps. Agents follow about 12 well: split it in two.`
    : stop(`${message.charAt(0).toUpperCase()}${message.slice(1)}`)
}

/** A refused save as lines to show: each problem it lists, or its own sentence when it lists none. */
export const refusedLines = (refused: { message: string; errors: { path: string; message: string }[] }) =>
  refused.errors.length
    ? refused.errors.map((error) => findingText({ code: '', message: error.message }))
    : [refused.message]

/**
 * What a flagged text asks of the owner, from what the checks find in it as stored: saving it as it is clears the
 * flag, unless it still names a tool the pack no longer has, which that save refuses.
 */
export const flagAdvice = (findings: Finding[]) =>
  findings.some((finding) => finding.level === 'error')
    ? {
        keep: false,
        text: 'Agents keep reading it as it is, with a name the pack no longer has. Edit it: it can’t be saved as it is.',
      }
    : {
        keep: true,
        text: 'Agents keep reading it as it is. Read it again: saving it, changed or not, clears this.',
      }

/** "3 steps · takes guest, door". */
export const argumentsLine = (playbook: Pick<OwnPlaybook, 'steps' | 'arguments'>) =>
  [
    playbook.steps ? plural(playbook.steps, 'step') : 'No numbered steps',
    playbook.arguments.length
      ? `takes ${playbook.arguments.map((argument) => argument.name).join(', ')}`
      : 'takes no arguments',
  ].join(' · ')

/** "All 6 sections", or how many of them and which are missing. */
export const sectionsLine = (sections: string[]) => {
  const missing = SKILL_SECTIONS.filter((section) => !sections.includes(section)).map((section) =>
    section.replace("'", '’'),
  )
  return missing.length
    ? `${SKILL_SECTIONS.length - missing.length} of ${SKILL_SECTIONS.length} sections · no ${missing.join(', ')}`
    : `All ${SKILL_SECTIONS.length} sections`
}

const SOURCE: Record<Version['source'], string | null> = {
  owner: null,
  ai: 'drafted by AI',
  import: 'from a config import',
}

/** "20 Nov, 09:30 · from a config import · served": when a version was saved, who wrote it when not the owner. */
export const versionLine = (version: Version, now = new Date()) =>
  [when(version.createdAt, now), SOURCE[version.source], version.live ? 'served' : null]
    .filter((part) => part !== null)
    .join(' · ')
