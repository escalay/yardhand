import { describe, expect, it } from 'vitest'
import { judge } from '../packs/checks.js'
import { applyLines, type Draft, type DraftTool, linesOf, missingNeeds, touchedOf } from './proposal.js'

const live = (name: string, inputs: string[], readOnly = true) => ({
  name,
  inputSchema: { type: 'object', properties: Object.fromEntries(inputs.map((input) => [input, { type: 'string' }])) },
  versionId: `tv_${name}`,
  access: null,
  annotations: readOnly ? { readOnlyHint: true } : {},
})
const tool = (name: string, inputs: string[], extra: Partial<DraftTool> = {}, readOnly = true): DraftTool => ({
  key: name,
  name,
  tool: name,
  live: live(name, inputs, readOnly),
  fixed: {},
  defaults: {},
  person: {},
  wording: null,
  ...extra,
})
const SAY_IT = '---\ntitle: Say it\ndescription: Says a word back.\n---\n\n1. Run `fixture.echo` with the word.\n'
const GREET =
  '---\ntitle: Greet a guest\ndescription: Greets from the desk.\n---\n\n1. Run `fixture.greet` from {{desk_name}}.\n'
const SKILL = '## What it is for\nGreeting at {{desk_name}} with `fixture.greet`.\n'

const before: Draft = {
  name: 'desk',
  title: 'Desk',
  tools: [tool('fixture.echo', ['text'])],
  variables: [],
  playbooks: [{ name: 'say-it', markdown: SAY_IT, wrote: ['fixture.echo'] }],
  skill: null,
  heldPlaybooks: [],
  manualPaths: [],
  upstreams: ['fixture'],
}
const after: Draft = {
  ...before,
  tools: [
    tool('fixture.echo', ['text'], { wording: 'Says the text back.' }),
    tool('fixture.greet', ['to', 'from'], { fixed: { from: '{{desk_name}}' } }),
    tool('fixture.shout', ['text'], {}, false),
  ],
  variables: [{ name: 'desk_name', value: 'the desk', description: 'Who greets.' }],
  playbooks: [...before.playbooks, { name: 'greet-guest', markdown: GREET, wrote: [] }],
  skill: { markdown: SKILL, wrote: [] },
}

describe('a proposal’s lines', () => {
  const lines = linesOf(before, after, { 'tool:fixture.greet': 'Greets the guest.' })
  const byId = new Map(lines.map((line) => [line.id, line]))

  it('has one line per tool, wording, variable, input, playbook and the skill, with before and after', () => {
    expect(lines.map((line) => [line.id, line.change])).toEqual([
      ['tool:fixture.greet', 'add'],
      ['tool:fixture.shout', 'add'],
      ['wording:fixture.echo', 'add'],
      ['input:fixture.greet.from', 'add'],
      ['variable:desk_name', 'add'],
      ['playbook:greet-guest', 'add'],
      ['skill', 'add'],
    ])
    expect(byId.get('tool:fixture.greet')).toMatchObject({
      kind: 'tool',
      target: 'fixture.greet',
      before: null,
      after: { tool: 'fixture.greet' },
      reason: 'Greets the guest.',
    })
    expect(byId.get('wording:fixture.echo')).toMatchObject({ before: null, after: 'Says the text back.' })
    expect(byId.get('input:fixture.greet.from')).toMatchObject({
      before: { mode: 'agent', value: null },
      after: { mode: 'fixed', value: '{{desk_name}}' },
    })
    expect(byId.get('variable:desk_name')?.after).toEqual({ value: 'the desk', description: 'Who greets.' })
  })

  it('says what each line needs: its tool, and the variables and tools its text writes', () => {
    expect(byId.get('input:fixture.greet.from')?.needs).toEqual(['tool:fixture.greet', 'variable:desk_name'])
    expect(byId.get('playbook:greet-guest')?.needs).toEqual(['tool:fixture.greet', 'variable:desk_name'])
    expect(byId.get('skill')?.needs).toEqual(['tool:fixture.greet', 'variable:desk_name'])
    expect(byId.get('wording:fixture.echo')?.needs).toEqual([])
  })

  it('marks a tool that changes things, and leaves it unticked', () => {
    expect(byId.get('tool:fixture.shout')).toMatchObject({ changesThings: true, suggested: false })
    expect(byId.get('tool:fixture.greet')).toMatchObject({ changesThings: false, suggested: true })
  })

  it('names a chosen line whose needs aren’t chosen', () => {
    expect(missingNeeds(lines, ['input:fixture.greet.from', 'tool:fixture.greet'])).toEqual([
      { line: 'input:fixture.greet.from', needs: ['variable:desk_name'] },
    ])
    expect(missingNeeds(lines, ['input:fixture.greet.from', 'tool:fixture.greet', 'variable:desk_name'])).toEqual([])
  })

  it('applies a subset to a state the checks can judge', () => {
    const chosen = lines.filter((line) => ['tool:fixture.greet', 'wording:fixture.echo'].includes(line.id))
    const applied = applyLines(before, after, chosen)
    expect(applied.tools.map((entry) => [entry.name, entry.wording, entry.fixed])).toEqual([
      ['fixture.echo', 'Says the text back.', {}],
      ['fixture.greet', null, {}],
    ])
    expect(judge(before, applied, touchedOf(chosen)).refused).toEqual([])
    const all = applyLines(before, after, lines)
    expect(all.variables).toEqual(after.variables)
    expect(all.skill?.markdown).toBe(SKILL)
    expect(judge(before, all, touchedOf(lines)).refused).toEqual([])
  })

  it('applies a removed tool a kept playbook names, and leaves the playbook flagged, not refused', () => {
    const without: Draft = { ...before, tools: [] }
    const removing = linesOf(before, without, {})
    expect(removing.map((line) => [line.id, line.change])).toEqual([['tool:fixture.echo', 'remove']])
    const applied = applyLines(before, without, removing)
    const judged = judge(before, applied, touchedOf(removing))
    expect(judged.refused).toEqual([])
    expect(judged.findings).toContainEqual(expect.objectContaining({ level: 'error', path: 'playbooks.say-it' }))
  })
})
