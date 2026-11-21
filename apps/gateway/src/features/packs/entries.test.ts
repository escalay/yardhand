import { describe, expect, it } from 'vitest'
import { inputProblems, lostInputs, presented, resolveEntry, shownSchema } from './entries.js'

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

describe('lostInputs', () => {
  it('names the values whose input the tool dropped', () => {
    expect(lostInputs(schema, { from: 'the desk', sender: 'the desk' })).toEqual(['sender'])
  })
})
