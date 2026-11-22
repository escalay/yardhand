import { describe, expect, it } from 'vitest'
import type { Schemas } from '@/api/client'
import {
  buildNote,
  costLine,
  estimateLine,
  findingsByLine,
  groupsOf,
  labelOf,
  orphansOf,
  overCap,
  preselected,
  realCallsLine,
  rehearsalLine,
  sidesOf,
  skippedLine,
  startProblem,
  stoppedLine,
  tasksProblem,
  toggled,
  withNeeds,
} from './build.rules'

type Line = Schemas['PackBuildLine']

const line = (id: string, more: Partial<Line> = {}): Line => {
  const kind = (id === 'skill' ? 'skill' : id.slice(0, id.indexOf(':'))) as Line['kind']
  return {
    id,
    kind,
    target: id === 'skill' ? 'SKILL' : id.slice(id.indexOf(':') + 1),
    change: 'add',
    before: null,
    after: null,
    reason: null,
    changesThings: false,
    suggested: true,
    needs: [],
    ...more,
  }
}

const LINES = [
  line('tool:echo.count_slowly'),
  line('tool:items.delete_item', { changesThings: true, suggested: false }),
  line('variable:tone', { after: { value: 'plain', description: 'How replies are worded.' } }),
  line('input:echo.count_slowly.pace', { needs: ['tool:echo.count_slowly', 'variable:tone'] }),
  line('wording:echo.echo', { change: 'change', before: 'Echoes.', after: 'Says it back.' }),
  line('playbook:count-along', { needs: [] }),
  line('skill', { needs: ['tool:echo.count_slowly', 'variable:tone'] }),
]

describe('the estimate', () => {
  it('says what a build is likely to cost against the cap, or that it can’t know', () => {
    expect(estimateLine({ usd: 0.31, capUsd: 1, priceKnown: true })).toBe('About $0.31 of $1.00')
    expect(estimateLine({ usd: 0.004, capUsd: 1, priceKnown: true })).toBe('Under $0.01 of $1.00')
    expect(estimateLine({ usd: null, capUsd: 1, priceKnown: false })).toBe(
      'Cost not known for this provider: held to a token budget',
    )
    expect(overCap({ usd: 1.2, capUsd: 1 })).toBe(true)
    expect(overCap({ usd: null, capUsd: 1 })).toBe(false)
  })

  it('counts the real read calls a rehearsal may make', () => {
    expect(realCallsLine(12)).toBe('up to 12 real read calls on your accounts')
    expect(realCallsLine(1)).toBe('up to 1 real read call on your accounts')
  })

  it('asks for one to five tasks of 3 to 300 characters', () => {
    expect(tasksProblem([''])).toBe('Give at least one example task.')
    expect(tasksProblem(['find a recipe', '  '])).toBeNull()
    expect(tasksProblem(['ab'])).toBe('Task 1 is too short: say it in a few words.')
    expect(tasksProblem(['find a recipe', 'x'.repeat(301)])).toBe('Task 2 is too long: 300 characters at most.')
  })
})

describe('starting a build', () => {
  const title = 'Loud'
  it('says why a start was refused, and what to do', () => {
    expect(startProblem({ status: 409, message: 'Build with AI has no model to ask: …' }, title)).toEqual({
      text: 'Build with AI has no model to ask: …',
      settings: true,
    })
    expect(startProblem({ status: 409, message: 'A build is already running for Loud: wait for it.' }, title)).toEqual({
      text: 'A build is already running for Loud: wait for it.',
      settings: false,
    })
    expect(
      startProblem({ status: 429, code: 'spend_cap', message: 'Estimated at $1.20: give fewer example tasks.' }, title),
    ).toEqual({ text: 'Estimated at $1.20: give fewer example tasks.', settings: false })
    expect(
      startProblem({ status: 429, code: 'too_many_requests', message: 'More than 6 calls…', retryAfter: 1500 }, title),
    ).toEqual({
      text: 'Loud has had six builds this hour, counting refused ones: try again in 25 minutes.',
      settings: false,
    })
  })

  it('says a build is waiting on the pack page', () => {
    expect(buildNote(null)).toBeNull()
    expect(buildNote({ id: 'pb_1', status: 'running' })).toBe('A build is running')
    expect(buildNote({ id: 'pb_1', status: 'ready' })).toBe('A proposal is ready')
    expect(buildNote({ id: 'pb_1', status: 'stopped' })).toBe('A proposal is ready')
  })
})

describe('the proposal', () => {
  it('groups lines as the screen shows them: tools with their wording and inputs, variables, playbooks, skill', () => {
    expect(groupsOf(LINES).map((group) => [group.title, group.lines.map((entry) => entry.id)])).toEqual([
      [
        'Tools',
        ['tool:echo.count_slowly', 'tool:items.delete_item', 'input:echo.count_slowly.pace', 'wording:echo.echo'],
      ],
      ['Variables', ['variable:tone']],
      ['Playbooks', ['playbook:count-along']],
      ['Skill', ['skill']],
    ])
    expect(groupsOf([line('skill')]).map((group) => group.title)).toEqual(['Skill'])
  })

  it('names each line', () => {
    expect(LINES.map(labelOf)).toEqual([
      'Tool echo.count_slowly',
      'Tool items.delete_item',
      'Variable tone',
      'Input pace of echo.count_slowly',
      'Wording of echo.echo',
      'Playbook count-along',
      'The skill',
    ])
    expect(labelOf(line('tool:echo.shout', { change: 'remove' }))).toBe('Tool echo.shout')
  })

  it('starts with what the build suggests: never a tool that changes things', () => {
    expect(preselected(LINES)).not.toContain('tool:items.delete_item')
    expect(preselected(LINES)).toContain('skill')
  })

  it('ticks what a line needs, and keeps a line another ticked line needs', () => {
    expect([...withNeeds(['input:echo.count_slowly.pace'], LINES)].sort()).toEqual([
      'input:echo.count_slowly.pace',
      'tool:echo.count_slowly',
      'variable:tone',
    ])
    const chosen = ['tool:echo.count_slowly', 'variable:tone', 'skill']
    expect(orphansOf('variable:tone', chosen, LINES).map(labelOf)).toEqual(['The skill'])
    expect(orphansOf('skill', chosen, LINES)).toEqual([])
    // Ticking brings its needs; unticking a needed line is held, with whom it is held for
    expect(toggled('skill', [], LINES)).toEqual({
      chosen: ['skill', 'tool:echo.count_slowly', 'variable:tone'],
      heldFor: [],
    })
    expect(toggled('variable:tone', chosen, LINES)).toEqual({ chosen, heldFor: ['The skill'] })
    expect(toggled('skill', chosen, LINES)).toEqual({
      chosen: ['tool:echo.count_slowly', 'variable:tone'],
      heldFor: [],
    })
  })

  it('reads each line’s before and after as text, Markdown for playbooks and the skill', () => {
    expect(sidesOf(line('tool:echo.count_slowly', { after: { tool: 'echo.count_slowly' } }))).toEqual({
      before: null,
      after: 'runs echo.count_slowly',
      markdown: false,
    })
    expect(
      sidesOf(
        line('input:echo.count_slowly.pace', {
          change: 'change',
          before: { mode: 'default', value: 2 },
          after: { mode: 'fixed', value: '{{tone}}' },
        }),
      ),
    ).toEqual({ before: 'Default: 2', after: 'Fixed: "{{tone}}"', markdown: false })
    expect(
      sidesOf(
        line('input:a.b', {
          change: 'remove',
          before: { mode: 'fixed', value: true },
          after: { mode: 'agent', value: null },
        }),
      ),
    ).toEqual({
      before: 'Fixed: true',
      after: 'Agent decides',
      markdown: false,
    })
    expect(sidesOf(LINES[2] as Line)).toEqual({
      before: null,
      after: '"plain" · How replies are worded.',
      markdown: false,
    })
    expect(sidesOf(line('skill', { change: 'change', before: '## A', after: '## B' }))).toEqual({
      before: '## A',
      after: '## B',
      markdown: true,
    })
  })

  it('files each finding of a refused accept beside its line', () => {
    const found = findingsByLine([
      { path: 'tools.echo.count_slowly.fixed.pace', message: 'refused' },
      { path: 'variables.tone', message: 'bad' },
      { path: 'playbooks.count-along', message: 'names a tool' },
      { path: 'skill', message: 'no section' },
      { path: 'name', message: 'elsewhere' },
    ])
    expect(Object.fromEntries(found.byLine)).toEqual({
      'input:echo.count_slowly.pace': ['refused'],
      'variable:tone': ['bad'],
      'playbook:count-along': ['names a tool'],
      skill: ['no section'],
    })
    expect(found.elsewhere).toEqual(['elsewhere'])
  })
})

describe('the rehearsal and the cost', () => {
  it('says each task in a line: what came of it, and what was skipped', () => {
    expect(
      rehearsalLine({
        task: 'Reply',
        outcome: 'Draft written.',
        steps: [
          { tool: 'mail.draft', ran: true, callId: 'call_1', standIn: null, error: null },
          {
            tool: 'mail.send',
            ran: false,
            callId: null,
            standIn: '[Not run in rehearsal: mail.send changes things. Assume it worked.]',
            error: null,
          },
        ],
      }),
    ).toBe('Reply: draft written, send skipped')
    expect(rehearsalLine({ task: 'Find roles', outcome: 'Found 14 postings.', steps: [] })).toBe(
      'Find roles: found 14 postings',
    )
  })

  it('says why a step was skipped', () => {
    const step = (standIn: string) => ({ tool: 'mail.send', ran: false, callId: null, standIn, error: null })
    expect(skippedLine(step('[Not run in rehearsal: mail.send changes things. Assume it worked.]'))).toBe(
      'send skipped: it changes things, so it was not tried',
    )
    expect(skippedLine(step('[Not run in rehearsal: mail.send is switched off by the owner.]'))).toBe(
      'send skipped: you switched it off, so it was not tried',
    )
    expect(skippedLine(step('[Not run in rehearsal: mail.send is not live.]'))).toBe(
      'send skipped: it is not live, so it was not tried',
    )
    expect(skippedLine(step('[Not in Loud: mail.send. Use one of its tools.]'))).toBe(
      'send skipped: it is not in the pack, so it was not tried',
    )
    expect(skippedLine(step('[Something new.]'))).toBe('send skipped: Something new.')
  })

  it('says what a build spent against the cap', () => {
    expect(costLine({ usd: 0.31, tokens: 9000, modelCalls: 7, known: true }, 1)).toBe('$0.31 of $1.00')
    expect(costLine({ usd: 0.004, tokens: 900, modelCalls: 2, known: true }, 1)).toBe('Under $0.01 of $1.00')
    expect(costLine({ usd: 0, tokens: 12_345, modelCalls: 3, known: false }, 1)).toBe(
      '12,345 tokens: cost not known for this provider',
    )
  })

  it('says where a stopped build stopped, and what it didn’t do', () => {
    expect(stoppedLine({ stopped: 'cap', notDone: ['the skill', 'the rehearsal of “Reply”'] }, 1)).toBe(
      'Stopped at $1.00. Not done: the skill, the rehearsal of “Reply”. What is here can still be accepted.',
    )
    expect(stoppedLine({ stopped: 'provider', notDone: ['the skill'] }, 1)).toBe(
      'Stopped: the provider refused to spend more (no credit left, or a limit on the key). Not done: the skill. What is here can still be accepted.',
    )
    expect(stoppedLine({ stopped: null, notDone: [] }, 1)).toBeNull()
  })
})
