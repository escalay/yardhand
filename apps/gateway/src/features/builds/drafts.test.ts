/** How a kit answer is read onto the pack: only what the model meant to change, within what the pack's routes take. */
import { describe, expect, it } from 'vitest'
import { PLAYBOOK_NAME } from '../packs/playbook.js'
import type { LiveTool } from '../tools/repo.js'
import { applyKit, applyPlaybook, candidatesOf } from './drafts.js'
import type { Draft, DraftTool } from './proposal.js'

const greet = {
  name: 'fixture.greet',
  inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
  versionId: 'tv_greet',
  access: null,
  annotations: { readOnlyHint: true },
}
const held = (wording: string | null): DraftTool => ({
  key: 'fixture.greet',
  name: 'fixture.greet',
  tool: 'fixture.greet',
  live: greet,
  fixed: {},
  defaults: {},
  person: {},
  wording,
})
const pack = (tools: DraftTool[], variables: Draft['variables'] = []): Draft => ({
  name: 'desk',
  title: 'Desk',
  tools,
  variables,
  playbooks: [],
  skill: null,
  heldPlaybooks: [],
  manualPaths: [],
  upstreams: ['fixture'],
})
const OWN = 'My own careful wording for greet.'
const wordingAfter = (wording: unknown) =>
  applyKit(
    pack([held(OWN)]),
    { tools: [{ name: 'fixture.greet', reason: 'keep', ...(wording === undefined ? {} : { wording }) }] },
    [],
  ).draft.tools[0]?.wording

describe('a kit answer on a tool the pack holds', () => {
  it('keeps the owner’s wording when the model leaves it out or answers null', () => {
    expect(wordingAfter(undefined)).toBe(OWN)
    expect(wordingAfter(null)).toBe(OWN)
  })

  it('changes it only to new text, and clears it only for an empty string', () => {
    expect(wordingAfter('Greets a guest from the desk.')).toBe('Greets a guest from the desk.')
    expect(wordingAfter('')).toBeNull()
  })

  it('gives a new tool no wording for an empty string', () => {
    const { draft } = applyKit(pack([]), { tools: [{ name: 'fixture.greet', reason: 'add', wording: '' }] }, [
      greet as unknown as LiveTool,
    ])
    expect(draft.tools[0]?.wording).toBeNull()
  })
})

describe('the tools a build looks at', () => {
  const connections = [
    { id: 'kit', title: 'Kit Library', enabled: true },
    { id: 'quiet', title: 'Quiet Archive', enabled: true },
    { id: 'gone', title: 'Gone', enabled: false },
  ]
  /** Search finds tools of the large kit connection only, different ones for each question, as on a gateway of 1,000. */
  const questionOf = (q: string) => Number(/#(\d)/.exec(q)?.[1] ?? 9)
  const repos = (off: string[] = []) =>
    ({
      upstreams: { list: async () => connections },
      meaning: {
        names: async (q: string, limit: number) => [
          'gone.hidden',
          ...Array.from({ length: limit }, (_, at) => `kit.meant_${questionOf(q)}_${at}`),
        ],
      },
      tools: {
        searchNames: async (q: string, limit: number, upstreams: string[]) =>
          upstreams.length === 1 && upstreams[0] === 'quiet'
            ? Array.from({ length: limit }, (_, at) => `quiet.note_${at}`)
            : Array.from({ length: limit }, (_, at) => `kit.word_${questionOf(q)}_${at}`),
        liveMany: async (names: string[]) =>
          names.map((name) => ({
            name,
            upstreamId: name.slice(0, name.indexOf('.')),
            access: off.includes(name) ? 'off' : null,
          })),
      },
    }) as unknown as Parameters<typeof candidatesOf>[0]
  const purpose = 'Everything a front desk does #0'
  const tasks = [1, 2, 3, 4, 5].map((count) => `task #${count}`)

  it('gives the purpose and every task its share, the last task too', async () => {
    const found = (await candidatesOf(repos(), ['kit.held'], [purpose, ...tasks])).map((tool) => tool.name)
    expect(found).toHaveLength(60)
    expect(found[0]).toBe('kit.held')
    for (const question of [0, 1, 2, 3, 4, 5])
      expect(found.filter((name) => name.includes(`_${question}_`)).length).toBeGreaterThanOrEqual(9)
  })

  it('keeps room for the tasks when the pack already holds more tools than a build looks at', async () => {
    const held = Array.from({ length: 70 }, (_, at) => `kit.held_${at}`)
    const found = (await candidatesOf(repos(), held, ['task #1', 'task #2', 'task #3'])).map((tool) => tool.name)
    expect(found).toHaveLength(60)
    expect(found.filter((name) => name.startsWith('kit.held_'))).toHaveLength(30)
    for (const question of [1, 2, 3])
      expect(found.filter((name) => name.includes(`_${question}_`)).length).toBeGreaterThanOrEqual(10)
  })

  it('never offers a tool switched off or on a connection that is off, nor lets one take a place', async () => {
    const found = (await candidatesOf(repos(['kit.meant_5_0']), [], [purpose, ...tasks])).map((tool) => tool.name)
    expect(found).toHaveLength(60)
    expect(found).not.toContain('kit.meant_5_0')
    expect(found).not.toContain('gone.hidden')
  })

  it('offers the tools of a connection a task names, by its id or its title', async () => {
    for (const task of ['find a note in quiet #5', 'find a note in the quiet archive #5']) {
      const found = (await candidatesOf(repos(), [], [purpose, ...tasks.slice(0, 4), task])).map((tool) => tool.name)
      // A few of its best matches, and still the task's own share of what search finds
      expect(found.filter((name) => name.startsWith('quiet.'))).toEqual([
        'quiet.note_0',
        'quiet.note_1',
        'quiet.note_2',
        'quiet.note_3',
      ])
      expect(found.filter((name) => name.includes('_5_')).length).toBeGreaterThanOrEqual(5)
    }
    // A word that only happens to be a connection's id comes after the task's best search hit
    const room = (await candidatesOf(repos(), [], ['keep the quiet room tidy #5'])).map((tool) => tool.name)
    expect(room.slice(0, 2)).toEqual(['kit.meant_5_0', 'quiet.note_0'])
    // A word of a title is not the connection's name
    const found = (await candidatesOf(repos(), [], ['find an archive of loud notes'])).map((tool) => tool.name)
    expect(found.filter((name) => name.startsWith('quiet.'))).toEqual([])
  })
})

describe('a kit answer’s removals', () => {
  const echo = (live: DraftTool['live']): DraftTool => ({
    ...held(null),
    key: 'fixture.echo',
    name: 'fixture.echo',
    live,
  })
  const remove = (tools: DraftTool[]) =>
    applyKit(
      pack(tools),
      {
        tools: [],
        remove: tools.map((tool) => ({ name: tool.name, reason: 'No task needs it.' })),
      },
      [],
    )

  it('keeps a tool that is live and switched on, saying why', () => {
    const { draft, skipped, reasons } = remove([held(null)])
    expect(draft.tools.map((tool) => tool.name)).toEqual(['fixture.greet'])
    expect(skipped).toEqual([
      {
        name: 'fixture.greet',
        reason:
          'Kept: it is live and switched on, and a build takes out only a tool that is not. Remove it on the pack’s page if you mean to.',
      },
    ])
    expect(reasons).toEqual({})
  })

  it('takes out a tool that is not live, or that the owner switched off', () => {
    const { draft, skipped, reasons } = remove([echo(null), { ...held(null), live: { ...greet, access: 'off' } }])
    expect(draft.tools).toEqual([])
    expect(skipped).toEqual([])
    expect(Object.keys(reasons)).toEqual(['tool:fixture.echo', 'tool:fixture.greet'])
  })
})

describe('a playbook’s name', () => {
  const PLAYBOOK = '---\ntitle: A task\ndescription: One of the tasks.\n---\n\n1. Do it.\n'
  const owned = (names: string[], heldPlaybooks: string[] = []): Draft => ({
    ...pack([]),
    playbooks: names.map((name) => ({ name, markdown: PLAYBOOK, wrote: [] })),
    heldPlaybooks,
  })
  const nameOf = (draft: Draft, answer: Record<string, unknown>, task: string, written = new Set<string>()) =>
    applyPlaybook(draft, { markdown: PLAYBOOK, ...answer }, task, written).name

  it('is never a word like task: one the model gives that says nothing is taken from the task', () => {
    for (const name of ['task', 'task-2', 'turn', 'playbook', 'Task!'])
      expect(nameOf(owned([]), { name }, 'Find the onboarding screens of a banking app')).toBe(
        'find-onboarding-screens-banking-app',
      )
    expect(nameOf(owned([]), { name: 'find-pricing-pages' }, 'Find pricing pages')).toBe('find-pricing-pages')
  })

  it('taken from any task is a name a playbook can have, short enough to number', () => {
    for (const task of [
      '2025 report: sum up the 3 biggest invoices and the 12 smallest ones, then the totals by month and year',
      'écrire un résumé',
      '写一封邮件',
      'do it',
    ]) {
      const name = nameOf(owned([]), { name: 'task' }, task)
      expect(name).toMatch(PLAYBOOK_NAME)
      expect(name.length).toBeLessThanOrEqual(60)
      expect(name).not.toMatch(/^task/)
    }
  })

  it('never lands on a playbook the pack already has, its own or a connection’s, nor one this build wrote', () => {
    const draft = owned(['find-pricing-pages'], ['desk-find-pricing'])
    expect(nameOf(draft, { name: 'find-pricing-pages' }, 'Find pricing pages')).toBe('find-pricing-pages-2')
    expect(nameOf(draft, { name: 'desk-find-pricing' }, 'Find pricing pages')).toBe('desk-find-pricing-2')
    const written = new Set<string>()
    const first = nameOf(owned([]), { name: 'task' }, 'Find pricing pages', written)
    const second = nameOf(owned([]), { name: 'task' }, 'Find pricing pages', written)
    expect([first, second]).toEqual(['find-pricing-pages', 'find-pricing-pages-2'])
  })

  it('is the playbook’s own only when the model says it revises one of the pack’s, as shown to it', () => {
    const draft = owned(['find-pricing-pages'], ['desk-find-pricing'])
    expect(nameOf(draft, { name: 'find-pricing-pages', revises: true }, 'Find pricing pages')).toBe(
      'find-pricing-pages',
    )
    // A connection's playbook is never the pack's to revise, and a text this build wrote is revised only once
    expect(nameOf(draft, { name: 'desk-find-pricing', revises: true }, 'Find pricing')).toBe('desk-find-pricing-2')
    const written = new Set(['find-pricing-pages'])
    expect(nameOf(draft, { name: 'find-pricing-pages', revises: true }, 'Find pricing pages', written)).toBe(
      'find-pricing-pages-2',
    )
  })
})

describe('a kit answer’s variables', () => {
  it('keeps a description to the 400 characters the variables route takes', () => {
    const { draft } = applyKit(
      pack([]),
      { tools: [], variables: [{ name: 'desk_name', value: 'the desk', description: 'w'.repeat(600) }] },
      [],
    )
    expect(draft.variables[0]?.description).toHaveLength(400)
  })

  it('adds none past the 100 a pack holds, and says which were left out', () => {
    const variables = Array.from({ length: 95 }, (_, index) => ({
      name: `held_${index}`,
      value: index,
      description: null,
    }))
    const proposed = Array.from({ length: 10 }, (_, index) => ({ name: `new_${index}`, value: index }))
    const { draft, skipped } = applyKit(
      pack([], variables),
      { tools: [], variables: [{ name: 'held_0', value: 'changed' }, ...proposed] },
      [],
    )
    expect(draft.variables).toHaveLength(100)
    expect(draft.variables[0]).toMatchObject({ name: 'held_0', value: 'changed' })
    expect(skipped.map((entry) => entry.name)).toEqual(['new_5', 'new_6', 'new_7', 'new_8', 'new_9'])
    expect(skipped[0]?.reason).toBe('A pack holds 100 variables at most, so this variable was not added.')
  })
})
