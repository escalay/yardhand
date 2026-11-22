import { describe, expect, it } from 'vitest'
import { ProblemError } from '../../kit/index.js'
import { checkPack, type Finding, judge, throwOnRefused } from './checks.js'
import { type PackState, withEntry, withTools, withVariables } from './state.js'

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
  ...values,
})
const desk = (over: Partial<PackState> = {}): PackState => ({
  name: 'desk',
  title: 'Front desk',
  tools: [entry('greet_from_desk', { fixed: { from: '{{desk}}' } })],
  variables: [{ name: 'desk', value: 'the desk', description: null }],
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
