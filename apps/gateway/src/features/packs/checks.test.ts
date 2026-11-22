import { describe, expect, it } from 'vitest'
import { ProblemError } from '../../kit/index.js'
import {
  checkPack,
  type Finding,
  judge,
  perPersonOf,
  personValueProblems,
  throwOnRefused,
  usesOf,
  variableKindOf,
} from './checks.js'
import { SKILL_SECTIONS } from './skill.js'
import { type PackState, withDoc, withEntry, withTools, withVariables } from './state.js'

const greet = {
  name: 'fixture.greet',
  inputSchema: {
    type: 'object',
    properties: { to: { type: 'string' }, from: { type: 'string', enum: ['the desk', 'the boss'] } },
    required: ['to', 'from'],
  },
}
const entry = (name: string, values: Partial<PackState['tools'][number]> = {}): PackState['tools'][number] => ({
  key: name,
  name,
  tool: 'fixture.greet',
  live: greet,
  fixed: {},
  defaults: {},
  person: {},
  ...values,
})
const desk = (over: Partial<PackState> = {}): PackState => ({
  name: 'desk',
  title: 'Front desk',
  tools: [entry('greet_from_desk', { fixed: { from: '{{desk}}' } })],
  variables: [{ name: 'desk', value: 'the desk', description: null }],
  playbooks: [],
  skill: null,
  heldPlaybooks: [],
  manualPaths: [],
  upstreams: ['fixture'],
  ...over,
})
const codes = (findings: Finding[]) => findings.map((finding) => [finding.level, finding.code, finding.path])

describe('checkPack', () => {
  it('finds nothing in a pack whose values fit', () => {
    expect(checkPack(desk())).toEqual([])
  })

  it('errors on an input the tool does not take, a value its schema refuses and an input in two modes', () => {
    const found = checkPack(
      desk({
        tools: [
          entry('greet_from_desk', { fixed: { colour: 'red', from: 'the desk' } }),
          entry('greet_from_boss', { defaults: { from: 'the owner' } }),
          entry('greet_twice', { fixed: { from: 'the desk' }, defaults: { from: 'the boss' } }),
        ],
        variables: [],
      }),
    )
    expect(codes(found)).toEqual([
      ['error', 'unknown_input', 'tools.greet_from_desk.fixed.colour'],
      ['error', 'bad_value', 'tools.greet_from_boss.defaults.from'],
      ['error', 'two_modes', 'tools.greet_twice.defaults.from'],
    ])
    expect(found[0]?.message).toBe('fixture.greet has no input colour')
  })

  it('checks a value after the pack’s variables are filled in', () => {
    const found = checkPack(desk({ variables: [{ name: 'desk', value: 'the lobby', description: null }] }))
    expect(codes(found)).toEqual([['error', 'bad_value', 'tools.greet_from_desk.fixed.from']])
    expect(found[0]?.message).toBe('from must be equal to one of the allowed values')
  })

  it('errors on a bad variable name and on one named twice', () => {
    const found = checkPack(
      desk({
        tools: [],
        variables: [
          { name: 'Desk', value: 'the desk', description: null },
          { name: 'city', value: 'Lisbon', description: null },
          { name: 'city', value: 'Porto', description: null },
        ],
      }),
    )
    expect(codes(found).filter(([level]) => level === 'error')).toEqual([
      ['error', 'bad_variable_name', 'variables.Desk'],
      ['error', 'duplicate_variable', 'variables.city'],
    ])
    expect(found[0]?.message).toBe(
      'Desk is not a variable name: start with a lowercase letter, then lowercase letters, digits or _ (40 at most), like desk_name',
    )
    expect(found[1]?.message).toBe('city is declared twice: keep one')
  })

  it('warns about a variable nothing uses and a word that is no variable', () => {
    const found = checkPack(
      desk({
        tools: [entry('greet_from_desk', { fixed: { from: '{{first_name}}' } })],
      }),
    )
    // Sent as written, it does not fit the enum either: that is an error of its own
    expect(codes(found)).toEqual([
      ['warning', 'not_a_variable', 'tools.greet_from_desk.fixed.from'],
      ['error', 'bad_value', 'tools.greet_from_desk.fixed.from'],
      ['warning', 'unused_variable', 'variables.desk'],
    ])
    expect(found[2]?.message).toBe('desk is not used by any tool yet')
  })

  it('warns that a tool that is not live cannot have its values checked', () => {
    const found = checkPack(
      desk({
        tools: [entry('greet_from_desk', { live: null, fixed: { from: '{{desk}}' } }), entry('greet', { live: null })],
      }),
    )
    expect(codes(found)).toEqual([['warning', 'not_live', 'tools.greet_from_desk']])
    expect(found[0]?.message).toBe('fixture.greet is not live, so its values are not checked: sync its upstream')
  })
})

describe('judge', () => {
  const flagged = desk({
    tools: [
      entry('greet_from_desk', { fixed: { sender: 'the desk' } }),
      entry('greet_from_boss', { fixed: { sender: 'the boss' } }),
    ],
    variables: [],
  })

  it('does not refuse an error the pack already had, where the change does not touch it', () => {
    const after = withEntry(flagged, 'greet_from_desk', { fixed: { from: 'the desk' } })
    const { refused, findings } = judge(flagged, after, ['tools.greet_from_desk.fixed'])
    expect(refused).toEqual([])
    expect(codes(findings)).toEqual([['error', 'unknown_input', 'tools.greet_from_boss.fixed.sender']])
  })

  it('refuses the same error where the change sends it again', () => {
    const after = withEntry(flagged, 'greet_from_boss', { fixed: { sender: 'the boss' } })
    expect(codes(judge(flagged, after, ['tools.greet_from_boss.fixed']).refused)).toEqual([
      ['error', 'unknown_input', 'tools.greet_from_boss.fixed.sender'],
    ])
  })

  it('refuses an error the change brings in', () => {
    const before = desk()
    const after = withEntry(before, 'greet_from_desk', { defaults: { from: 'the boss' } })
    expect(codes(judge(before, after, ['tools.greet_from_desk.defaults']).refused)).toEqual([
      ['error', 'two_modes', 'tools.greet_from_desk.defaults.from'],
    ])
    const moved = withVariables(before, [{ name: 'desk', value: 'the lobby', description: null }])
    expect(codes(judge(before, moved, ['variables']).refused)).toEqual([
      ['error', 'bad_value', 'tools.greet_from_desk.fixed.from'],
    ])
  })

  it('does not take a rename for a new problem: the finding keeps the stored name as its key', () => {
    const after = withEntry(flagged, 'greet_from_boss', { name: 'greet_from_ceo' })
    const { refused, findings } = judge(flagged, after, [])
    expect(refused).toEqual([])
    expect(findings.map((finding) => [finding.path, finding.key])).toContainEqual([
      'tools.greet_from_ceo.fixed.sender',
      'tools.greet_from_boss.fixed.sender',
    ])
  })

  it('touches a name only, never another that starts the same', () => {
    const before = desk({
      tools: [entry('greet', { fixed: { from: 'the desk' } }), entry('greet_old', { fixed: { sender: 'the desk' } })],
      variables: [],
    })
    const after = withEntry(before, 'greet', { fixed: { from: 'the boss' } })
    expect(judge(before, after, ['tools.greet']).refused).toEqual([])
  })

  it('refuses removing a variable a value still writes, naming the tool and the input', () => {
    const before = desk()
    const { refused } = judge(before, withVariables(before, []), ['variables'])
    expect(refused).toEqual([
      {
        level: 'error',
        code: 'variable_in_use',
        path: 'variables.desk',
        key: 'variables.desk',
        message: '{{desk}} is still used by greet_from_desk (from): change that first, or keep the variable.',
      },
    ])
    const free = withEntry(before, 'greet_from_desk', { fixed: { from: 'the desk' } })
    expect(judge(free, withVariables(free, []), ['variables']).refused).toEqual([])
  })
})

describe('checkPack on a Per person input', () => {
  const open = (over: Partial<PackState> = {}) =>
    desk({
      tools: [entry('greet_by_city', { person: { from: '{{city}}' } })],
      variables: [{ name: 'city', value: null, description: null }],
      ...over,
    })

  it('finds nothing in an input that reads one declared variable, with or without a value of the pack’s', () => {
    expect(checkPack(open())).toEqual([])
    expect(checkPack(open({ variables: [{ name: 'city', value: 'the desk', description: null }] }))).toEqual([])
    expect(perPersonOf(open(), 'city')).toBe(true)
    expect(perPersonOf(open({ tools: [] }), 'city')).toBe(false)
  })

  it('says a variable’s kind as the Per person inputs that read it take it, whether or not the pack has a value', () => {
    const counted = {
      name: 'fixture.count',
      inputSchema: { type: 'object', properties: { times: { type: 'integer' }, loud: { type: 'boolean' } } },
    }
    const tally = open({
      tools: [
        entry('greet_by_city', { person: { from: '{{city}}' } }),
        entry('count', { tool: 'fixture.count', live: counted, person: { times: '{{times}}', loud: '{{loud}}' } }),
      ],
      variables: [
        { name: 'city', value: null, description: null },
        { name: 'times', value: null, description: null },
        { name: 'loud', value: null, description: null },
      ],
    })
    expect(tally.variables.map((variable) => variableKindOf(tally, variable))).toEqual(['text', 'number', 'boolean'])
  })

  it('says a number for an input that takes a number or null, with no value of the pack’s', () => {
    const nullable = open({
      tools: [
        entry('count', {
          live: {
            name: 'fixture.count',
            inputSchema: { type: 'object', properties: { times: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } },
          },
          person: { times: '{{times}}' },
        }),
      ],
      variables: [{ name: 'times', value: null, description: null }],
    })
    expect(nullable.variables.map((variable) => variableKindOf(nullable, variable))).toEqual(['number'])
  })

  it('falls back to the kind of the pack’s value, then text, where the inputs that read it don’t say one kind', () => {
    const mixed = open({
      tools: [
        entry('greet_by_city', { person: { from: '{{city}}' } }),
        entry('greet_gone', { live: null, person: { to: '{{gone}}' } }),
        entry('count', {
          live: { name: 'fixture.count', inputSchema: { type: 'object', properties: { times: { type: 'integer' } } } },
          person: { times: '{{city}}' },
        }),
      ],
      variables: [
        { name: 'city', value: 7, description: null },
        { name: 'gone', value: null, description: null },
        { name: 'loud', value: true, description: null },
      ],
    })
    // city is read as text and as a number, gone by a tool that is not live, loud by no input per person
    expect(mixed.variables.map((variable) => variableKindOf(mixed, variable))).toEqual(['number', 'text', 'boolean'])
  })

  it('errors on an input that is not one declared variable, and on one in two modes', () => {
    const found = checkPack(
      open({
        tools: [
          entry('greet_twice', { fixed: { from: 'the desk' }, person: { from: '{{city}}' } }),
          entry('greet_town', { person: { from: '{{town}}', to: 'Sam in {{city}}' } }),
        ],
      }),
    )
    expect(codes(found)).toEqual([
      ['error', 'two_modes', 'tools.greet_twice.person.from'],
      ['error', 'person_variable', 'tools.greet_town.person.from'],
      ['error', 'person_variable', 'tools.greet_town.person.to'],
    ])
  })

  it('checks the pack’s own value of it as the input’s fallback', () => {
    expect(codes(checkPack(open({ variables: [{ name: 'city', value: 'Porto', description: null }] })))).toEqual([
      ['error', 'bad_value', 'tools.greet_by_city.person.from'],
    ])
  })

  it('errors on a fixed value or a text that writes a variable with no value of the pack’s', () => {
    const found = checkPack(
      open({
        tools: [
          entry('greet_by_city', { person: { from: '{{city}}' } }),
          entry('greet', { fixed: { to: '{{city}}' } }),
        ],
        playbooks: [{ name: 'say-hello', markdown: 'Greet {{city}} with `greet`.', wrote: [] }],
      }),
    )
    expect(codes(found)).toEqual([
      ['error', 'no_value', 'tools.greet.fixed.to'],
      ['error', 'no_value', 'playbooks.say-hello'],
    ])
    expect(found[1]?.message).toBe(
      '{{city}} has no value of Front desk, so only an input filled per person can read it: give it a value under Variables.',
    )
  })

  it('refuses taking the pack’s value away while a playbook or the skill writes the variable', () => {
    const before = open({
      variables: [{ name: 'city', value: 'the desk', description: null }],
      skill: { markdown: 'Greeting people from {{city}}.', wrote: [] },
    })
    const emptied = withVariables(before, [{ name: 'city', value: null, description: null }])
    expect(judge(before, emptied, ['variables']).refused).toEqual([
      expect.objectContaining({
        code: 'no_value',
        path: 'variables.city',
        message:
          '{{city}} is still written by the skill, which only the pack’s value can fill: keep a value, or change that first.',
      }),
    ])
    // Read by the Per person input alone, it can go
    const read = open({ variables: [{ name: 'city', value: 'the desk', description: null }] })
    expect(
      judge(read, withVariables(read, [{ name: 'city', value: null, description: null }]), ['variables']).refused,
    ).toEqual([])
  })

  it('refuses removing a variable a Per person input reads', () => {
    const before = open()
    expect(codes(judge(before, withVariables(before, []), ['variables']).refused)).toEqual([
      ['error', 'variable_in_use', 'variables.city'],
    ])
  })
})

describe('personValueProblems', () => {
  const state = desk({
    tools: [
      entry('greet_by_city', { person: { from: '{{city}}' } }),
      entry('greet_to_city', { person: { to: '{{city}}' } }),
      entry('greet_from_desk', { fixed: { from: '{{desk}}' } }),
    ],
    variables: [
      { name: 'city', value: null, description: null },
      { name: 'desk', value: 'the desk', description: null },
    ],
  })

  it('finds nothing in a value every input that reads it takes, and in a value taken away', () => {
    expect(personValueProblems(state, { city: 'the boss' })).toEqual([])
    expect(personValueProblems(state, { city: null })).toEqual([])
  })

  it('names the variable for a value an input that reads it refuses', () => {
    expect(personValueProblems(state, { city: 7 })).toEqual([
      expect.objectContaining({
        level: 'error',
        code: 'bad_value',
        path: 'values.city',
        message: 'city doesn’t fit greet_by_city: from must be string',
      }),
      expect.objectContaining({ path: 'values.city', message: 'city doesn’t fit greet_to_city: to must be string' }),
    ])
  })

  it('takes a value only for a variable a Per person input reads', () => {
    expect(personValueProblems(state, { desk: 'the boss', town: 'Porto' })).toEqual([
      expect.objectContaining({
        code: 'not_per_person',
        path: 'values.desk',
        message:
          'desk is not filled per person in Front desk: only a variable a Per person input reads takes a person’s value.',
      }),
      expect.objectContaining({ code: 'not_per_person', path: 'values.town' }),
    ])
  })
})

describe('a pack’s state after a change', () => {
  it('keeps a name already in the pack as it is, adds the rest at the end, then removes', () => {
    const before = desk()
    const after = withTools(
      before,
      [entry('greet_from_desk', { fixed: { sender: 'someone' } }), entry('greet_from_boss'), entry('greet_from_boss')],
      [],
    )
    expect(after.tools.map((tool) => [tool.name, tool.fixed])).toEqual([
      ['greet_from_desk', { from: '{{desk}}' }],
      ['greet_from_boss', {}],
    ])
    expect(withTools(after, [], ['greet_from_desk']).tools.map((tool) => tool.name)).toEqual(['greet_from_boss'])
  })

  it('renames an entry and replaces only the maps it is given', () => {
    const before = desk({ tools: [entry('greet_from_desk', { fixed: { from: 'the desk' }, defaults: { to: 'Sam' } })] })
    expect(withEntry(before, 'greet_from_desk', { name: 'greet_sam', fixed: {} }).tools).toEqual([
      entry('greet_from_desk', { name: 'greet_sam', fixed: {}, defaults: { to: 'Sam' } }),
    ])
  })
})

describe('throwOnRefused', () => {
  const messageOf = (refused: Finding[]) => {
    try {
      throwOnRefused(refused)
    } catch (error) {
      return (error as ProblemError).message
    }
    return null
  }

  it('throws nothing when nothing is refused', () => {
    expect(() => throwOnRefused([])).not.toThrow()
  })

  it('throws a 400 that names every problem, each with its place', () => {
    const refused = checkPack(
      desk({ tools: [entry('greet_from_desk', { fixed: { colour: 'red', from: 7 } })] }),
    ).filter((finding) => finding.level === 'error')
    const thrown = (() => {
      try {
        throwOnRefused(refused)
      } catch (error) {
        return error
      }
    })()
    expect(thrown).toBeInstanceOf(ProblemError)
    expect((thrown as ProblemError).options.errors).toEqual([
      { in: 'body', path: 'tools.greet_from_desk.fixed.colour', message: 'fixture.greet has no input colour' },
      { in: 'body', path: 'tools.greet_from_desk.fixed.from', message: 'from must be string' },
    ])
    expect((thrown as ProblemError).message).toBe(
      'Not saved: greet_from_desk: fixture.greet has no input colour; greet_from_desk: from must be string. GET /api/tools/fixture.greet shows its inputs.',
    )
  })

  it('says which of the pack’s tools each problem is in, and names the tools to read when they are several', () => {
    const echo = { name: 'fixture.echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }
    const refused = checkPack(
      desk({
        tools: [
          entry('greet_a', { fixed: { from: '{{desk}}' } }),
          entry('greet_b', { defaults: { from: '{{desk}}' } }),
          entry('fixture.echo', { tool: 'fixture.echo', live: echo, fixed: { volume: 3 } }),
        ],
        variables: [{ name: 'desk', value: 'the lobby', description: null }],
      }),
    )
    expect(messageOf(refused)).toBe(
      'Not saved: greet_a: from must be equal to one of the allowed values; greet_b: from must be equal to one of the allowed values; fixture.echo has no input volume. GET /api/tools/{name} shows the inputs of each: fixture.greet, fixture.echo.',
    )
  })

  it('names a tool the pack calls like one of its inputs, and says a tool’s own name once', () => {
    const refused = checkPack(
      desk({
        tools: [entry('from', { fixed: { from: 7 } }), entry('fixture.greet', { fixed: { colour: 'red', from: 7 } })],
      }),
    ).filter((finding) => finding.level === 'error')
    expect(messageOf(refused)).toBe(
      'Not saved: from: from must be string; fixture.greet has no input colour; fixture.greet: from must be string. GET /api/tools/fixture.greet shows its inputs.',
    )
  })

  it('points at no tool for a refusal that is only about variables', () => {
    const { refused } = judge(desk(), withVariables(desk(), []), ['variables'])
    expect(messageOf(refused)).toBe(
      'Not saved: {{desk}} is still used by greet_from_desk (from): change that first, or keep the variable.',
    )
  })
})

describe('checkPack on a pack’s own playbooks', () => {
  const echo = {
    name: 'fixture.echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, posted_since: { type: 'string' } } },
    access: null,
    annotations: { readOnlyHint: true },
  }
  const shout = {
    name: 'fixture.shout',
    inputSchema: { type: 'object', properties: {} },
    access: null,
    annotations: {},
  }
  const playbook = (markdown: string, name = 'say-hello', wrote: string[] = []) => ({ name, markdown, wrote })
  const withPlaybook = (markdown: string, over: Partial<PackState> = {}) =>
    desk({
      tools: [
        entry('greet_from_desk', { fixed: { from: '{{desk}}' } }),
        entry('fixture.echo', { tool: 'fixture.echo', live: echo }),
        entry('fixture.shout', { tool: 'fixture.shout', live: shout }),
      ],
      playbooks: [playbook(markdown)],
      ...over,
    })
  const found = (markdown: string, over: Partial<PackState> = {}) =>
    checkPack(withPlaybook(markdown, over)).filter((finding) => finding.path.startsWith('playbooks.'))

  it('finds nothing in a playbook that names the pack’s tools by the pack’s names', () => {
    const state = withPlaybook(
      '---\narguments:\n  - name: guest\n---\n1. Run `greet_from_desk` for {{guest}} from {{desk}}.\n2. Say it with `fixture.echo`.',
    )
    expect(checkPack(state)).toEqual([])
    expect(usesOf(state)).toEqual({ 'playbooks.say-hello': ['greet_from_desk', 'fixture.echo'] })
  })

  it('errors on a tool of a connection that is not in the pack', () => {
    const [finding, ...rest] = found('Run `fixture.whisper`.')
    expect(rest).toEqual([])
    expect(finding).toEqual({
      level: 'error',
      code: 'not_in_pack',
      path: 'playbooks.say-hello',
      key: 'playbooks.say-hello',
      message: '`fixture.whisper` is not in Front desk: add it to the pack, or take it out of the text.',
    })
  })

  it('errors on a tool named by its own name where the pack gives it another, naming that one', () => {
    expect(found('Run `fixture.greet`.').map((finding) => [finding.level, finding.code, finding.message])).toEqual([
      ['error', 'use_alias', '`fixture.greet` is called `greet_from_desk` in Front desk: write that.'],
    ])
    const twice = found('Run `fixture.greet`.', {
      tools: [entry('greet_from_desk'), entry('greet_from_boss')],
    })
    expect(twice.map((finding) => finding.message)).toEqual([
      '`fixture.greet` is called `greet_from_desk` and `greet_from_boss` in Front desk: write the one you mean.',
    ])
  })

  it('warns about a name shaped like a tool that the pack does not know, and about nothing it does know', () => {
    const markdown = [
      '---',
      'arguments:',
      '  - name: guest_name',
      '---',
      'Run `greet_desk`, never `gret.from`. Set `posted_since` and `guest_name`, read `SKILL.md` and `notes.json`,',
      'find more with `search_tools`, follow `say-bye` and `fixture-say-it-back`, use `desk`, `call_tool` and `0.6.0`.',
    ].join('\n')
    const state = withPlaybook(markdown, {
      playbooks: [playbook(markdown), playbook('Wave.', 'say-bye')],
      heldPlaybooks: ['fixture-say-it-back'],
    })
    expect(checkPack(state).map((finding) => [finding.level, finding.code, finding.path, finding.message])).toEqual([
      [
        'warning',
        'unknown_name',
        'playbooks.say-hello',
        '`greet_desk` is not a tool of Front desk. If it is meant as one, check the name.',
      ],
      [
        'warning',
        'unknown_name',
        'playbooks.say-hello',
        '`gret.from` is not a tool of Front desk. If it is meant as one, check the name.',
      ],
    ])
  })

  it('errors on a name the text was written for that is no longer a tool of the pack', () => {
    const state = desk({
      playbooks: [
        playbook('Run `greet_from_door`, then `extra.echo`.', 'say-hello', ['greet_from_door', 'extra.echo']),
      ],
    })
    expect(checkPack(state).map((finding) => [finding.level, finding.code, finding.message])).toEqual([
      [
        'error',
        'left_pack',
        '`greet_from_door` is no longer a tool of Front desk: write the name it has now, or take it out of the text.',
      ],
      [
        'error',
        'left_pack',
        '`extra.echo` is no longer a tool of Front desk: write the name it has now, or take it out of the text.',
      ],
    ])
  })

  it('knows a name the text was written for however it is shaped', () => {
    const state = desk({ playbooks: [playbook('Run `greet`, then `wave`.', 'say-hello', ['greet'])] })
    expect(checkPack(state).map((finding) => [finding.code, finding.message])).toEqual([
      [
        'left_pack',
        '`greet` is no longer a tool of Front desk: write the name it has now, or take it out of the text.',
      ],
    ])
  })

  it('errors on a {{word}} that is neither an argument nor a variable: in a text it is never sent as written', () => {
    expect(
      found('Greet {{guest}} from {{desk}}.').map((finding) => [finding.level, finding.code, finding.message]),
    ).toEqual([
      [
        'error',
        'unresolved',
        '{{guest}} is neither an argument of this playbook nor a variable of Front desk: declare one, or take it out.',
      ],
    ])
  })

  it('reads a {{word}} inside a code block too: an argument or a variable passes, any other is an error', () => {
    const markdown = [
      '---',
      'arguments:',
      '  - name: guest',
      '---',
      '```json',
      '{"text": "{{guest}} at {{desk}}, by {{nope}}"}',
      '```',
      '~~~',
      '{{door}}',
      '~~~',
    ].join('\n')
    expect(found(markdown).map((finding) => [finding.code, finding.message])).toEqual([
      [
        'unresolved',
        '{{nope}} is neither an argument of this playbook nor a variable of Front desk: declare one, or take it out.',
      ],
      [
        'unresolved',
        '{{door}} is neither an argument of this playbook nor a variable of Front desk: declare one, or take it out.',
      ],
    ])
  })

  it('warns about a {{…}} that is not written as a name: nothing fills it in', () => {
    expect(
      found('Greet {{Guest}} and {{guest-name}} from {{ desk }}, never {{}}.').map((finding) => [
        finding.level,
        finding.code,
        finding.message,
      ]),
    ).toEqual([
      [
        'warning',
        'not_a_name',
        '{{Guest}} is not filled in, so agents read it as written: a name is a lowercase letter, then lowercase letters, digits or _.',
      ],
      [
        'warning',
        'not_a_name',
        '{{guest-name}} is not filled in, so agents read it as written: a name is a lowercase letter, then lowercase letters, digits or _.',
      ],
      [
        'warning',
        'not_a_name',
        '{{}} is not filled in, so agents read it as written: a name is a lowercase letter, then lowercase letters, digits or _.',
      ],
    ])
  })

  it('errors on an argument named like a variable of the pack', () => {
    expect(
      found('---\narguments:\n  - name: desk\n---\nGreet from {{desk}}.').map((finding) => [
        finding.level,
        finding.code,
        finding.message,
      ]),
    ).toEqual([
      [
        'error',
        'name_clash',
        'the argument desk is also a variable of Front desk: rename one, so {{desk}} means one thing.',
      ],
    ])
  })

  it('errors on an argument named like what every object has', () => {
    expect(
      found('---\narguments:\n  - name: constructor\n---\nBuild {{constructor}}.').map((finding) => [
        finding.level,
        finding.code,
        finding.message,
      ]),
    ).toEqual([
      [
        'error',
        'bad_argument_name',
        'constructor is a name every object already has, so it can’t name an argument: pick another, like guest_name.',
      ],
    ])
  })

  it('errors on front matter it cannot read, with each thing wrong', () => {
    expect(found('---\ntitle: [a, b]\n---\nGreet.').map((finding) => [finding.code, finding.message])).toEqual([
      ['bad_front_matter', 'title is a list: write it as text'],
    ])
  })

  it('warns that a read-only key cannot run a tool that changes things', () => {
    expect(found('Run `fixture.shout`.').map((finding) => [finding.level, finding.code, finding.message])).toEqual([
      ['warning', 'needs_write', '`fixture.shout` changes things: a read-only key can’t run it.'],
    ])
  })

  it('asks to split a playbook past twelve steps', () => {
    const steps = (count: number) => Array.from({ length: count }, (_, step) => `${step + 1}. Greet.`).join('\n')
    expect(found(steps(12))).toEqual([])
    expect(found(steps(13)).map((finding) => [finding.level, finding.code, finding.message])).toEqual([
      ['warning', 'split', '13 steps: split it into playbooks of about 12 steps.'],
    ])
  })

  it('errors on a playbook named like one the pack holds from a connection, and on a name that is no name', () => {
    expect(
      found('Greet.', {
        playbooks: [playbook('Greet.', 'fixture-say-it-back')],
        heldPlaybooks: ['fixture-say-it-back'],
      }).map((finding) => [finding.level, finding.code, finding.message]),
    ).toEqual([
      [
        'error',
        'name_clash',
        'Front desk already holds a playbook called fixture-say-it-back, from a connection: give this one another name.',
      ],
    ])
    expect(found('Greet.', { playbooks: [playbook('Greet.', 'Say_Hello')] }).map((finding) => finding.code)).toEqual([
      'bad_name',
    ])
  })

  it('errors on a text over 60,000 characters and reads no further', () => {
    expect(
      found(`{{nobody}} ${'x'.repeat(60_000)}`).map((finding) => [finding.level, finding.code, finding.message]),
    ).toEqual([['error', 'too_big', '60,011 characters: 60,000 at most. Split it.']])
  })

  it('errors on a playbook with no text under its front matter', () => {
    expect(
      found('---\ntitle: Say hello\n---\n\n').map((finding) => [finding.level, finding.code, finding.message]),
    ).toEqual([['error', 'empty', 'the playbook has no text under its front matter: write its steps.']])
  })

  it('counts a variable a playbook writes as used', () => {
    const state = desk({ tools: [], playbooks: [playbook('Greet from {{desk}}.')] })
    expect(checkPack(state)).toEqual([])
    expect(codes(checkPack({ ...state, playbooks: [] }))).toEqual([['warning', 'unused_variable', 'variables.desk']])
  })
})

describe('checkPack on a pack’s skill', () => {
  const sections = SKILL_SECTIONS.map((section) => `## ${section}\n\nUse \`greet_from_desk\` from {{desk}}.`).join(
    '\n\n',
  )
  const withSkill = (markdown: string, over: Partial<PackState> = {}) =>
    desk({ skill: { markdown, wrote: [] }, ...over })

  it('finds nothing in a skill with the six sections, and notes the tools it names', () => {
    expect(checkPack(withSkill(sections))).toEqual([])
    expect(usesOf(withSkill(sections))).toEqual({ skill: ['greet_from_desk'] })
  })

  it('warns about the sections it lacks, in one line', () => {
    expect(
      checkPack(withSkill('## What it is for\n\nGreeting.\n\n## Gotchas\n\nNone.')).map((finding) => [
        finding.level,
        finding.code,
        finding.path,
        finding.message,
      ]),
    ).toEqual([
      [
        'warning',
        'missing_section',
        'skill',
        'no section Which tool for which job, Values already set, Playbooks, What it can’t do: add each as a `## ` heading.',
      ],
    ])
  })

  it('errors on a {{word}} that is no variable, and on a tool that is not in the pack', () => {
    expect(
      checkPack(withSkill(`${sections}\n\nAsk {{guest}}. Run \`fixture.echo\`.`)).map((finding) => [
        finding.level,
        finding.code,
        finding.message,
      ]),
    ).toEqual([
      ['error', 'unresolved', '{{guest}} is no variable of Front desk: declare it, or take it out.'],
      ['error', 'not_in_pack', '`fixture.echo` is not in Front desk: add it to the pack, or take it out of the text.'],
    ])
  })

  it('reads a {{word}} inside a code block too: one that is no variable is an error', () => {
    expect(
      checkPack(withSkill(`${sections}\n\n\`\`\`\nfrom: {{desk}}, as {{guest}}\n\`\`\``)).map((finding) => [
        finding.code,
        finding.message,
      ]),
    ).toEqual([['unresolved', '{{guest}} is no variable of Front desk: declare it, or take it out.']])
  })

  it('warns when a manual the pack holds sits at the skill’s own address', () => {
    expect(
      checkPack(withSkill(sections, { manualPaths: ['desk', 'fixture'] })).map((finding) => [
        finding.level,
        finding.code,
        finding.message,
      ]),
    ).toEqual([
      [
        'warning',
        'skill_path',
        'a manual in Front desk is at skill://desk/SKILL.md too: the pack’s skill is served there, and the manual at its gateway:// address.',
      ],
    ])
  })
})

describe('checkPack on the playbooks a skill names', () => {
  const sections = (playbooks: string) =>
    SKILL_SECTIONS.map((section) =>
      section === 'Playbooks' ? `## ${section}\n\n${playbooks}` : `## ${section}\n\nUse \`greet_from_desk\`.`,
    ).join('\n\n')
  const findingsOf = (markdown: string, over: Partial<PackState> = {}) =>
    checkPack(desk({ skill: { markdown, wrote: [] }, ...over })).map((finding) => [
      finding.level,
      finding.code,
      finding.message,
    ])
  const own = (name: string) => ({ name, markdown: 'Run `greet_from_desk`.', wrote: [] })

  it('finds nothing when every playbook it names is one the pack has, its own or a connection’s', () => {
    expect(
      findingsOf(sections('- `say-hello`: greets.\n- `fixture-say-it-back`: says it back.\n- say-hello — again.'), {
        playbooks: [own('say-hello')],
        heldPlaybooks: ['fixture-say-it-back'],
      }),
    ).toEqual([])
  })

  it('warns about a playbook its Playbooks section names that the pack lacks, backticked or as a list item', () => {
    expect(
      findingsOf(sections('- `say-hello`: greets.\n- `find-roles`: finds roles.\n- reply-to-sam: answers Sam.'), {
        playbooks: [own('say-hello')],
      }),
    ).toEqual([
      [
        'warning',
        'unknown_playbook',
        '`find-roles` is no playbook of Front desk: write it, or take it out of the skill.',
      ],
      [
        'warning',
        'unknown_playbook',
        '`reply-to-sam` is no playbook of Front desk: write it, or take it out of the skill.',
      ],
    ])
  })

  it('outside that section, warns only about a name shaped like a connection’s playbook', () => {
    const markdown = `${sections('None yet.')}\n\nFollow \`fixture-say-nothing\`; a key can be \`read-only\`, see \`x-gateway-pack\`.`
    expect(findingsOf(markdown)).toEqual([
      [
        'warning',
        'unknown_playbook',
        '`fixture-say-nothing` is no playbook of Front desk: write it, or take it out of the skill.',
      ],
    ])
  })

  it('never takes a tool, a variable or a meta-tool in that section for a playbook', () => {
    expect(findingsOf(sections('Run `greet_from_desk` with `desk`, or find one with `get_playbook`.'))).toEqual([])
  })

  it('never takes a playbook’s argument or a tool’s input in that section for a playbook', () => {
    const withGuest = {
      name: 'say-hello',
      markdown: '---\narguments:\n  - name: guest\n---\nRun `greet_from_desk` for {{guest}}.',
      wrote: [],
    }
    expect(
      findingsOf(sections('- `say-hello`: greets `guest`, sent `from` the desk.\n- guest: who to greet.'), {
        playbooks: [withGuest],
      }),
    ).toEqual([])
  })

  it('reads `<upstream>-` as a playbook only for a connection the pack’s tools or playbooks come from', () => {
    const markdown = `${sections('None yet.')}\n\nSee \`quiet-hours\` and \`loud-mode\`, then follow \`fixture-say-nothing\`.`
    expect(findingsOf(markdown, { upstreams: ['fixture', 'quiet', 'loud'], heldPlaybooks: ['loud-warm-up'] })).toEqual([
      [
        'warning',
        'unknown_playbook',
        '`loud-mode` is no playbook of Front desk: write it, or take it out of the skill.',
      ],
      [
        'warning',
        'unknown_playbook',
        '`fixture-say-nothing` is no playbook of Front desk: write it, or take it out of the skill.',
      ],
    ])
  })
})

describe('checkPack on file names in a text', () => {
  it('never takes a backticked file name for a tool, but still knows a connection’s tool by its upstream', () => {
    const markdown =
      'Read `README.md`, `tokens.css`, `demo-effect.css`, `app.config.mjs`, `fixture.md`, `fixture.json` and `fixture.log`.'
    expect(
      checkPack(desk({ playbooks: [{ name: 'say-hello', markdown, wrote: [] }] })).map((finding) => [
        finding.code,
        finding.message,
      ]),
    ).toEqual([['not_in_pack', '`fixture.log` is not in Front desk: add it to the pack, or take it out of the text.']])
  })
})

describe('judge on a pack’s documents', () => {
  const named = desk({
    playbooks: [
      { name: 'say-hello', markdown: 'Run `greet_from_desk`.', wrote: ['greet_from_desk'] },
      { name: 'say-bye', markdown: 'Wave to {{nobody}}.', wrote: [] },
    ],
    skill: { markdown: 'Run `greet_from_desk` from {{desk}}.', wrote: ['greet_from_desk'] },
  })

  it('never refuses a tool’s new name or its removal for what a document then says', () => {
    const renamed = judge(named, withEntry(named, 'greet_from_desk', { name: 'greet_desk' }), [])
    expect(renamed.refused).toEqual([])
    expect(renamed.findings.filter((finding) => finding.code === 'left_pack').map((finding) => finding.path)).toEqual([
      'playbooks.say-hello',
      'skill',
    ])
    const removed = judge(named, withTools(named, [], ['greet_from_desk']), [])
    expect(removed.refused).toEqual([])
    const aliased = desk({
      tools: [entry('fixture.greet')],
      variables: [],
      playbooks: [{ name: 'say-hello', markdown: 'Run `fixture.greet`.', wrote: ['fixture.greet'] }],
    })
    const given = judge(aliased, withEntry(aliased, 'fixture.greet', { name: 'greet_from_desk' }), [])
    expect(given.refused).toEqual([])
    expect(given.findings.map((finding) => finding.code)).toEqual(['use_alias'])
  })

  it('refuses a document’s own errors when it is the one saved, and no other document’s', () => {
    const saved = withDoc(named, 'playbook', 'say-hello', 'Run `fixture.greet` for {{guest}}.')
    expect(judge(named, saved, ['playbooks.say-hello']).refused.map((finding) => [finding.code, finding.path])).toEqual(
      [
        ['unresolved', 'playbooks.say-hello'],
        ['use_alias', 'playbooks.say-hello'],
      ],
    )
    const fine = withDoc(named, 'playbook', 'say-hi', 'Run `greet_from_desk`.')
    expect(judge(named, fine, ['playbooks.say-hi']).refused).toEqual([])
    // The error it already had is refused too: the text is what the request sends
    expect(judge(named, named, ['playbooks.say-bye']).refused.map((finding) => finding.code)).toEqual(['unresolved'])
    // A playbook named like the start of another is not that other
    expect(judge(named, withDoc(named, 'playbook', 'say', 'Greet.'), ['playbooks.say']).refused).toEqual([])
  })

  it('keeps the names a text was written for when the text is saved again', () => {
    const moved = withEntry(named, 'greet_from_desk', { name: 'greet_desk' })
    const again = withDoc(moved, 'playbook', 'say-hello', 'Run `greet_from_desk`.')
    expect(judge(moved, again, ['playbooks.say-hello']).refused.map((finding) => finding.code)).toEqual(['left_pack'])
    const skill = withDoc(moved, 'skill', 'SKILL', 'Run `greet_from_desk` from {{desk}}.')
    expect(judge(moved, skill, ['skill']).refused.map((finding) => finding.code)).toEqual(['left_pack'])
    expect(withDoc(moved, 'skill', 'SKILL', null).skill).toBeNull()
    expect(withDoc(moved, 'playbook', 'say-bye', null).playbooks.map((doc) => doc.name)).toEqual(['say-hello'])
  })

  it('refuses removing a variable a document still writes, naming the document', () => {
    const before = desk({
      tools: [],
      playbooks: [{ name: 'say-hello', markdown: 'Greet from {{desk}}.', wrote: [] }],
      skill: { markdown: 'Greet from {{desk}}.', wrote: [] },
    })
    expect(judge(before, withVariables(before, []), ['variables']).refused).toEqual([
      {
        level: 'error',
        code: 'variable_in_use',
        path: 'variables.desk',
        key: 'variables.desk',
        message:
          '{{desk}} is still used by the playbook say-hello, the skill: change that first, or keep the variable.',
      },
    ])
  })

  it('lets a variable go that a playbook writes only as its own argument', () => {
    const before = desk({
      tools: [],
      variables: [{ name: 'guest', value: 'Sam', description: null }],
      playbooks: [
        { name: 'say-hello', markdown: '---\narguments:\n  - name: guest\n---\nGreet {{guest}}.', wrote: [] },
      ],
    })
    expect(codes(checkPack(before))).toEqual([
      ['warning', 'unused_variable', 'variables.guest'],
      ['error', 'name_clash', 'playbooks.say-hello'],
    ])
    expect(judge(before, withVariables(before, []), ['variables']).refused).toEqual([])
  })

  it('never refuses a new variable for the argument of the same name a playbook already has', () => {
    const before = desk({
      tools: [],
      variables: [],
      playbooks: [
        { name: 'say-hello', markdown: '---\narguments:\n  - name: guest\n---\nGreet {{guest}}.', wrote: [] },
      ],
    })
    const after = withVariables(before, [{ name: 'guest', value: 'Sam', description: null }])
    const { refused, findings } = judge(before, after, ['variables'])
    expect(refused).toEqual([])
    expect(findings.map((finding) => finding.code)).toEqual(['unused_variable', 'name_clash'])
  })
})
