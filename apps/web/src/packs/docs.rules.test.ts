import { describe, expect, it } from 'vitest'
import type { Schemas } from '@/api/client'
import {
  argumentsLine,
  byLevel,
  findingsLine,
  findingText,
  flagAdvice,
  isPlaybookName,
  playbookNameOf,
  playbookNameProblem,
  refusedLines,
  SKILL_SECTIONS,
  sectionsLine,
  starterPlaybook,
  starterSkill,
  versionLine,
} from './docs.rules'

type Finding = Schemas['PackFinding']
type Pack = Schemas['Pack']

const finding = (level: Finding['level'], code: string, message: string, path = 'playbooks.say-hello'): Finding => ({
  level,
  code,
  path,
  message,
})

const notInPack = finding(
  'error',
  'not_in_pack',
  '`echo.delete_menus` is not in Loud: add it to the pack, or take it out of the text.',
)
const needsWrite = finding(
  'warning',
  'needs_write',
  '`items.delete_item` changes things: a read-only key can’t run it.',
)

/** Every `{{name}}` a text writes, as the gateway reads a name. */
const written = (text: string) => [...text.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map((match) => match[1])
const headings = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1])
const backticked = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1])

describe('a playbook’s name', () => {
  it('is made from its title, in the shape the gateway takes', () => {
    expect(playbookNameOf('Say hello')).toBe('say-hello')
    expect(playbookNameOf('  Répondre à un invité!  ')).toBe('repondre-a-un-invite')
    // A name starts with a letter
    expect(playbookNameOf('7 days of echo')).toBe('days-of-echo')
    expect(playbookNameOf('x'.repeat(80))).toHaveLength(64)
    expect(playbookNameOf(`${'x'.repeat(63)} y`)).toBe('x'.repeat(63))
    for (const title of ['Say hello', '7 days of echo', 'x'.repeat(80), 'A–B: c/d'])
      expect(isPlaybookName(playbookNameOf(title))).toBe(true)
  })

  it('is left empty when the title gives fewer than three characters', () => {
    expect(playbookNameOf('Hi')).toBe('')
    expect(playbookNameOf('')).toBe('')
    expect(playbookNameOf('42')).toBe('')
  })

  it('says what is wrong with a typed one', () => {
    const taken = { own: ['say-hello'], held: ['echo-warm-up'] }
    expect(playbookNameProblem('find-roles', taken)).toBeNull()
    expect(playbookNameProblem('', taken)).toBe('Give it a name, like find-roles.')
    for (const bad of ['hi', 'Say-hello', '7-days', 'say_hello'])
      expect(playbookNameProblem(bad, taken)).toBe(
        'Start with a lowercase letter, then lowercase letters, digits or - (3 to 64), like find-roles.',
      )
    expect(playbookNameProblem('say-hello', taken)).toBe(
      'say-hello is already a playbook written for this pack: edit that one, or pick another name.',
    )
    expect(playbookNameProblem('echo-warm-up', taken)).toBe(
      'This pack already holds a playbook called echo-warm-up, from a connection: give this one another name.',
    )
  })
})

describe('the text a new playbook starts from', () => {
  it('carries the title in front matter, however it is written', () => {
    expect(starterPlaybook('Say hello')).toMatch(/^---\ntitle: "Say hello"\ndescription: /)
    expect(starterPlaybook('Say: "hi" # loud')).toContain('title: "Say: \\"hi\\" # loud"\n')
    expect(starterPlaybook('  ')).toContain('title: "Untitled playbook"\n')
  })

  it('declares every {{name}} it writes, numbers its steps and names no tool', () => {
    const text = starterPlaybook('Say hello')
    const [, frontMatter = '', body = ''] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? []
    const declared = [...frontMatter.matchAll(/^ {2}- name: (\w+)$/gm)].map((match) => match[1])
    expect(declared.length).toBeGreaterThan(0)
    expect(written(body).every((name) => declared.includes(name))).toBe(true)
    expect(written(body)).toEqual(expect.arrayContaining(declared))
    const steps = body.split('\n').filter((line) => /^\d+\. /.test(line))
    expect(steps.length).toBeGreaterThanOrEqual(2)
    expect(steps.length).toBeLessThanOrEqual(12)
    // A backticked name is read as a tool: the starter names none, so the checks have nothing to refuse
    expect(backticked(text)).toEqual([])
  })
})

describe('the text a new skill starts from', () => {
  const pack = {
    title: 'Loud',
    description: 'Say things back, loudly.\n\nMore about it.',
    variables: [
      { name: 'page_size', value: 5, description: 'How many items a look-up returns.', usedBy: ['items.get_item'] },
      { name: 'desk', value: 'the front desk', description: null, usedBy: [] },
    ],
    tools: [
      {
        name: 'echo.echo',
        wording: 'Says your words back exactly.\nCall it first.',
        upstreamDescription: 'Echoes the text back.',
        fixed: {},
        defaults: {},
      },
      {
        name: 'work_inbox',
        wording: null,
        upstreamDescription: 'Searches `mail` for {{query}}.',
        fixed: { account: 'work' },
        defaults: {},
      },
      {
        name: 'items.get_item',
        wording: null,
        upstreamDescription: null,
        fixed: {},
        defaults: { limit: '{{page_size}}', verbose: true },
      },
    ],
    playbooks: [{ name: 'echo-say-it-back', title: 'Echo · Say it back', description: 'Echo a topic, then shout it.' }],
    ownPlaybooks: [{ name: 'say-hello', title: 'Say hello', description: 'Greets a guest by name.' }],
  } as unknown as Pack
  const bare = { title: 'Bare', description: '', variables: [], tools: [], playbooks: [], ownPlaybooks: [] } as never

  it('has the six sections, in order, under the names the gateway looks for', () => {
    expect(SKILL_SECTIONS).toEqual([
      'What it is for',
      'Which tool for which job',
      'Values already set',
      'Playbooks',
      'Gotchas',
      "What it can't do",
    ])
    expect(headings(starterSkill(pack))).toEqual([...SKILL_SECTIONS])
    expect(headings(starterSkill(bare))).toEqual([...SKILL_SECTIONS])
    // The gateway writes the front matter and the first heading itself
    expect(starterSkill(pack)).toMatch(/^## What it is for\n\nSay things back, loudly\.\n/)
  })

  it('lists the pack’s tools by the names the pack calls them', () => {
    const text = starterSkill(pack)
    expect(text).toContain('- `echo.echo`: Says your words back exactly.\n')
    // Words that would be read as a tool or a variable are left out: the starter must pass the checks as it is
    expect(text).toContain('- `work_inbox`\n')
    expect(text).toContain('- `items.get_item`\n')
    expect(backticked(text).sort()).toEqual(
      [
        'echo.echo',
        'work_inbox',
        'items.get_item',
        'work_inbox',
        'items.get_item',
        'echo-say-it-back',
        'say-hello',
      ].sort(),
    )
  })

  it('says which values are already set: the variables, and the inputs the pack fills', () => {
    const text = starterSkill(pack)
    expect(text).toContain('- page_size: {{page_size}}. How many items a look-up returns.\n')
    expect(text).toContain('- desk: {{desk}}.\n')
    expect(text).toContain('- `work_inbox` always sends account: it is not yours to fill.\n')
    expect(text).toContain('- `items.get_item` fills limit, verbose when you leave them out.\n')
    // Only the pack's own variables are written as {{name}}
    expect([...new Set(written(text))]).toEqual(['page_size', 'desk'])
    expect(written(starterSkill(bare))).toEqual([])
    expect(starterSkill(bare)).toContain(
      '## Values already set\n\nNothing is set for you: every input is yours to fill.\n',
    )
  })

  it('lists the playbooks, the pack’s own first', () => {
    const text = starterSkill(pack)
    expect(text).toContain(
      '## Playbooks\n\n- `say-hello`: Greets a guest by name.\n- `echo-say-it-back`: Echo a topic, then shout it.\n',
    )
    expect(starterSkill(bare)).toContain('## Playbooks\n\nNone yet.\n')
  })
})

describe('what the checks found, in words', () => {
  it('puts errors before warnings', () => {
    expect(byLevel([needsWrite, notInPack]).map((found) => found.code)).toEqual(['not_in_pack', 'needs_write'])
    expect(byLevel([notInPack, needsWrite, { ...notInPack, code: 'unresolved' }]).map((found) => found.code)).toEqual([
      'not_in_pack',
      'unresolved',
      'needs_write',
    ])
  })

  it('sums them up, problems first', () => {
    expect(findingsLine([])).toBe('✓ Every tool named is in the pack and every {{…}} resolves')
    expect(findingsLine([needsWrite])).toBe(
      '✓ Every tool named is in the pack and every {{…}} resolves · 1 thing to look at',
    )
    expect(findingsLine([needsWrite, notInPack])).toBe('1 problem to fix before it can be saved · 1 thing to look at')
    expect(findingsLine([notInPack, notInPack])).toBe('2 problems to fix before it can be saved')
  })

  it('says each as a sentence, and a long playbook in the app’s own words', () => {
    expect(findingText(notInPack)).toBe(notInPack.message)
    expect(
      findingText(finding('error', 'empty', 'the playbook has no text under its front matter: write its steps.')),
    ).toBe('The playbook has no text under its front matter: write its steps.')
    expect(
      findingText(finding('error', 'bad_front_matter', 'arguments.0 has no name: give it one, like `name: guest`')),
    ).toBe('Arguments.0 has no name: give it one, like `name: guest`.')
    expect(
      findingText(finding('error', 'unresolved', '{{guest}} is no variable of Loud: declare it, or take it out.')),
    ).toBe('{{guest}} is no variable of Loud: declare it, or take it out.')
    expect(findingText(finding('warning', 'split', '14 steps: split it into playbooks of about 12 steps.'))).toBe(
      'This playbook has 14 steps. Agents follow about 12 well: split it in two.',
    )
  })

  it('says a refused save by its problems, or by its sentence when it lists none', () => {
    expect(
      refusedLines({
        message: 'Not saved: `echo.delete_menus` is not in Loud.',
        errors: [{ path: 'playbooks.say-hello', message: notInPack.message }],
      }),
    ).toEqual([notInPack.message])
    expect(refusedLines({ message: 'Loud already has a playbook called say-hello.', errors: [] })).toEqual([
      'Loud already has a playbook called say-hello.',
    ])
  })
})

describe('a flag on a playbook or the skill', () => {
  it('can be cleared by saving the text as it is when its tool only changed', () => {
    expect(flagAdvice([])).toEqual({
      keep: true,
      text: 'Agents keep reading it as it is. Read it again: saving it, changed or not, clears this.',
    })
    expect(flagAdvice([needsWrite]).keep).toBe(true)
  })

  it('needs the text changed when a tool it names has left the pack', () => {
    const left = finding(
      'error',
      'left_pack',
      '`greet_from_desk` is no longer a tool of Loud: write the name it has now, or take it out of the text.',
    )
    expect(flagAdvice([left])).toEqual({
      keep: false,
      text: 'Agents keep reading it as it is, with a name the pack no longer has. Edit it: it can’t be saved as it is.',
    })
  })
})

describe('a text’s row on the pack page', () => {
  it('says a playbook’s steps and what an agent fills', () => {
    const args = [
      { name: 'guest', description: null, required: true },
      { name: 'door', description: null, required: false },
    ]
    expect(argumentsLine({ steps: 3, arguments: args })).toBe('3 steps · takes guest, door')
    expect(argumentsLine({ steps: 1, arguments: [] })).toBe('1 step · takes no arguments')
    expect(argumentsLine({ steps: 0, arguments: [] })).toBe('No numbered steps · takes no arguments')
  })

  it('says which of the six sections a skill has', () => {
    expect(sectionsLine([...SKILL_SECTIONS])).toBe('All 6 sections')
    expect(sectionsLine(['What it is for', 'Playbooks'])).toBe(
      '2 of 6 sections · no Which tool for which job, Values already set, Gotchas, What it can’t do',
    )
  })

  it('says when a version was written and by whom', () => {
    const now = new Date('2026-11-21T15:00:00')
    const at = new Date('2026-11-20T09:30:00').toISOString()
    expect(versionLine({ id: 'pdv_1', source: 'owner', createdAt: at, live: true }, now)).toBe('20 Nov, 09:30 · served')
    expect(versionLine({ id: 'pdv_0', source: 'owner', createdAt: at, live: false }, now)).toBe('20 Nov, 09:30')
    expect(versionLine({ id: 'pdv_2', source: 'import', createdAt: at, live: false }, now)).toBe(
      '20 Nov, 09:30 · from a config import',
    )
    expect(versionLine({ id: 'pdv_3', source: 'ai', createdAt: at, live: false }, now)).toBe(
      '20 Nov, 09:30 · drafted by AI',
    )
  })
})
