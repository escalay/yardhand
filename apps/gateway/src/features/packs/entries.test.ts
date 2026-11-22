import { describe, expect, it } from 'vitest'
import {
  inputProblems,
  lostInputs,
  modeOf,
  presented,
  readersOf,
  resolveEntry,
  shownSchema,
  valueProblem,
} from './entries.js'

const schema = {
  type: 'object',
  properties: {
    to: { type: 'string' },
    from: { type: 'string', description: 'Who greets.' },
    within: { type: 'integer' },
  },
  required: ['to', 'from', 'within'],
}
const greet = { name: 'fixture.greet', description: 'Greets someone, from someone.', inputSchema: schema }

describe('shownSchema', () => {
  it('hides the fixed inputs: neither shown nor required', () => {
    const shown = shownSchema(schema, { fixed: { from: 'the desk' }, defaults: {} })
    expect(Object.keys(shown.properties as object)).toEqual(['to', 'within'])
    expect(shown.required).toEqual(['to', 'within'])
  })

  it('shows a default with its value and no longer requires it', () => {
    const shown = shownSchema(schema, { fixed: {}, defaults: { within: 7 } })
    expect(shown.properties).toEqual({
      to: { type: 'string' },
      from: { type: 'string', description: 'Who greets.' },
      within: { type: 'integer', default: 7 },
    })
    expect(shown.required).toEqual(['to', 'from'])
    // The tool's own schema is left as it was
    expect(schema.properties.within).toEqual({ type: 'integer' })
    expect(schema.required).toEqual(['to', 'from', 'within'])
  })

  it('leaves out a default the tool no longer takes, and a schema with nothing set', () => {
    expect(shownSchema(schema, { fixed: {}, defaults: { colour: 'red' } }).properties).toEqual(schema.properties)
    expect(shownSchema(schema, { fixed: {}, defaults: {} })).toBe(schema)
  })
})

describe('resolveEntry', () => {
  it('fills the pack’s variables into what it fixes and defaults', () => {
    const row = {
      toolName: 'fixture.greet',
      description: 'Greets for the desk.',
      fixed: JSON.stringify({ from: '{{desk}}' }),
      defaults: JSON.stringify({ within: '{{since_days}}' }),
    }
    expect(resolveEntry(row, { desk: 'the desk', since_days: 7 })).toEqual({
      tool: 'fixture.greet',
      wording: 'Greets for the desk.',
      fixed: { from: 'the desk' },
      defaults: { within: 7 },
      person: {},
      unset: [],
    })
    expect(resolveEntry({ ...row, fixed: null, defaults: null }, {})).toMatchObject({ fixed: {}, defaults: {} })
  })
})

describe('presented', () => {
  it('shows the tool under the pack’s name, in its wording, with its inputs as the pack sets them', () => {
    const shown = presented(greet, 'greet_from_desk', {
      wording: null,
      fixed: { from: 'the desk' },
      defaults: { within: 7 },
    })
    expect(shown).toMatchObject({ name: 'greet_from_desk', description: 'Greets someone, from someone.' })
    expect(shown.inputSchema.properties).toEqual({ to: { type: 'string' }, within: { type: 'integer', default: 7 } })
    expect(shown.inputSchema.required).toEqual(['to'])
  })
})

describe('inputProblems', () => {
  it('finds nothing wrong with values that fit', () => {
    expect(
      inputProblems(
        greet,
        { fixed: { from: '{{desk}}' }, defaults: { within: '{{since_days}}' } },
        { desk: 'the desk', since_days: 7 },
      ),
    ).toEqual([])
  })

  it('names an input the tool does not take', () => {
    expect(inputProblems(greet, { fixed: { colour: 'red' }, defaults: {} }, {})).toEqual([
      {
        input: 'colour',
        mode: 'fixed',
        level: 'error',
        code: 'unknown_input',
        message: 'fixture.greet has no input colour',
      },
    ])
  })

  it('checks the value after its variables are filled in', () => {
    expect(inputProblems(greet, { fixed: {}, defaults: { within: '{{desk}}' } }, { desk: 'the desk' })).toEqual([
      { input: 'within', mode: 'default', level: 'error', code: 'bad_value', message: 'within must be integer' },
    ])
    expect(inputProblems(greet, { fixed: { from: 7 }, defaults: {} }, {})).toEqual([
      expect.objectContaining({ input: 'from', mode: 'fixed', code: 'bad_value', message: 'from must be string' }),
    ])
  })

  it('checks an input whose schema is kept beside the inputs, under $defs or definitions', () => {
    const colours = { enum: ['red', 'blue'] }
    for (const [keyword, ref] of [
      ['$defs', '#/$defs/Colour'],
      ['definitions', '#/definitions/Colour'],
    ] as const) {
      const paint = {
        name: 'fixture.paint',
        inputSchema: {
          type: 'object',
          properties: { colour: { $ref: ref }, coats: { type: 'array', items: { $ref: ref } } },
          [keyword]: { Colour: colours },
        },
      }
      expect(inputProblems(paint, { fixed: { colour: 'red' }, defaults: { coats: ['blue', 'red'] } }, {})).toEqual([])
      expect(inputProblems(paint, { fixed: { colour: 'purple' }, defaults: { coats: ['blue', 'green'] } }, {})).toEqual(
        [
          {
            input: 'colour',
            mode: 'fixed',
            level: 'error',
            code: 'bad_value',
            message: 'colour must be equal to one of the allowed values',
          },
          {
            input: 'coats',
            mode: 'default',
            level: 'error',
            code: 'bad_value',
            message: 'coats must be equal to one of the allowed values',
          },
        ],
      )
    }
  })

  it('says a value was not checked where the input’s schema can’t be read, instead of passing it', () => {
    const paint = {
      name: 'fixture.paint',
      inputSchema: {
        type: 'object',
        properties: { colour: { enum: ['red', 'blue'] }, trim: { $ref: '#/properties/colour' } },
      },
    }
    expect(inputProblems(paint, { fixed: { trim: 'purple' }, defaults: {} }, {})).toEqual([
      {
        input: 'trim',
        mode: 'fixed',
        level: 'warning',
        code: 'not_checked',
        message: "trim is not checked: its schema can't be read here, so only a call checks it",
      },
    ])
  })

  it('refuses one input in two modes', () => {
    expect(inputProblems(greet, { fixed: { from: 'the desk' }, defaults: { from: 'the boss' } }, {})).toEqual([
      {
        input: 'from',
        mode: 'default',
        level: 'error',
        code: 'two_modes',
        message: 'from is both fixed and a default: keep it in one',
      },
    ])
  })

  it('only warns about a word that is no variable of the pack: it is sent as written', () => {
    expect(inputProblems(greet, { fixed: { from: 'Hello {{first_name}}' }, defaults: {} }, {})).toEqual([
      {
        input: 'from',
        mode: 'fixed',
        level: 'warning',
        code: 'not_a_variable',
        message: 'no variable first_name: sent as written',
      },
    ])
  })
})

describe('a Per person input', () => {
  const row = {
    toolName: 'fixture.greet',
    description: null,
    fixed: JSON.stringify({ to: '{{city}}' }),
    defaults: null,
    person: JSON.stringify({ from: '{{city}}' }),
  }

  it('is filled with the person’s value, else the pack’s, and hidden like a fixed input', () => {
    const sams = resolveEntry(row, { city: 'Lisbon' }, { city: 'Porto' })
    expect(sams).toMatchObject({ fixed: { to: 'Lisbon', from: 'Porto' }, person: { from: 'city' }, unset: [] })
    expect(resolveEntry(row, { city: 'Lisbon' })).toMatchObject({ fixed: { to: 'Lisbon', from: 'Lisbon' } })
    expect(Object.keys(shownSchema(schema, sams).properties as object)).toEqual(['within'])
  })

  it('is hidden and left out when it has no value at any level', () => {
    const none = resolveEntry({ ...row, fixed: null }, {})
    expect(none).toMatchObject({ fixed: {}, person: { from: 'city' }, unset: ['from'] })
    const shown = shownSchema(schema, none)
    expect(Object.keys(shown.properties as object)).toEqual(['to', 'within'])
    expect(shown.required).toEqual(['to', 'within'])
  })

  it('never takes a person’s value into a fixed or default input that writes the same variable', () => {
    expect(resolveEntry({ ...row, person: null }, { city: 'Lisbon' }, { city: 'Porto' })).toMatchObject({
      fixed: { to: 'Lisbon' },
    })
  })

  it('is its own mode', () => {
    expect(modeOf({ fixed: {}, defaults: {}, person: { from: '{{city}}' } }, 'from')).toBe('person')
  })

  it('reads one variable and nothing else, and the pack’s value of it must fit', () => {
    expect(inputProblems(greet, { fixed: {}, defaults: {}, person: { from: '{{city}}' } }, { city: 'Lisbon' })).toEqual(
      [],
    )
    expect(inputProblems(greet, { fixed: {}, defaults: {}, person: { from: '{{city}}' } }, {}, ['city'])).toEqual([])
    expect(
      inputProblems(greet, { fixed: {}, defaults: {}, person: { from: 'Hello {{city}}', to: '{{town}}' } }, {}, [
        'city',
      ]),
    ).toEqual([
      {
        input: 'from',
        mode: 'person',
        level: 'error',
        code: 'person_variable',
        message: 'from is filled per person from one variable, written {{name}} and nothing else',
      },
      {
        input: 'to',
        mode: 'person',
        level: 'error',
        code: 'person_variable',
        message: 'no variable town: declare it before an input reads it per person',
      },
    ])
    expect(
      inputProblems(greet, { fixed: {}, defaults: {}, person: { within: '{{city}}' } }, { city: 'Lisbon' }),
    ).toEqual([
      { input: 'within', mode: 'person', level: 'error', code: 'bad_value', message: 'within must be integer' },
    ])
  })

  it('is in one mode only', () => {
    expect(
      inputProblems(greet, { fixed: { from: 'the desk' }, defaults: {}, person: { from: '{{city}}' } }, {}, ['city']),
    ).toEqual([
      {
        input: 'from',
        mode: 'person',
        level: 'error',
        code: 'two_modes',
        message: 'from is both fixed and per person: keep it in one',
      },
    ])
  })

  it('leaves a variable with no value of the pack’s to Per person inputs: a fixed or default value can’t write it', () => {
    expect(inputProblems(greet, { fixed: { from: 'from {{city}}' }, defaults: {} }, {}, ['city'])).toEqual([
      {
        input: 'from',
        mode: 'fixed',
        level: 'error',
        code: 'no_value',
        message:
          '{{city}} has no value of the pack, so only an input filled per person can read it: give it a value, or make from Per person',
      },
    ])
  })

  it('says which inputs read a variable per person', () => {
    expect(readersOf({ from: '{{city}}', to: '{{ city }}', within: '{{days}}' }, 'city')).toEqual(['from', 'to'])
  })

  it('checks a person’s value against the input it fills', () => {
    expect(valueProblem(greet, 'from', 'Porto')).toBeNull()
    expect(valueProblem(greet, 'within', 'Porto')).toBe('within must be integer')
    expect(valueProblem(greet, 'colour', 'red')).toBeNull()
  })
})

describe('lostInputs', () => {
  it('names the values whose input the tool dropped', () => {
    expect(lostInputs(schema, { from: 'the desk', sender: 'the desk' })).toEqual(['sender'])
  })
})

describe('an input named like something every object has', () => {
  const built = {
    name: 'fixture.build',
    description: 'Builds.',
    inputSchema: { type: 'object', properties: { constructor: { type: 'string' }, toString: { type: 'boolean' } } },
  }

  it('is the agent’s until the pack sets it, and then in the mode the pack chose', () => {
    expect(modeOf({ fixed: {}, defaults: {} }, 'constructor')).toBe('agent')
    expect(modeOf({ fixed: {}, defaults: { constructor: 'x' } }, 'constructor')).toBe('default')
    expect(modeOf({ fixed: { constructor: 'x' }, defaults: {} }, 'constructor')).toBe('fixed')
  })

  it('takes a default without being read as fixed too', () => {
    expect(inputProblems(built, { fixed: {}, defaults: { constructor: 'x' } }, {})).toEqual([])
  })

  it('is shown as the tool has it when the pack gives another input a default', () => {
    const shown = shownSchema(built.inputSchema, { fixed: {}, defaults: { constructor: 'x' } })
    expect(shown.properties).toEqual({ constructor: { type: 'string', default: 'x' }, toString: { type: 'boolean' } })
  })

  it('is unknown to a tool that has no such input, and lost when the tool drops it', () => {
    expect(inputProblems(greet, { fixed: { constructor: 'x' }, defaults: {} }, {})).toEqual([
      expect.objectContaining({ code: 'unknown_input', message: 'fixture.greet has no input constructor' }),
    ])
    expect(lostInputs(schema, { constructor: 'x', from: 'the desk' })).toEqual(['constructor'])
  })
})
