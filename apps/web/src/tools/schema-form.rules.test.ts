import { describe, expect, it } from 'vitest'
import { argumentsOf, fieldsOf, valuesOf } from './schema-form.rules'

const schema = {
  type: 'object',
  required: ['q'],
  properties: {
    q: { type: 'string', description: 'What to look for.' },
    limit: { type: 'integer', default: 12, minimum: 1, maximum: 50 },
    mode: { type: 'string', enum: ['look', 'meaning', 'both'] },
    exact: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
  },
}

describe('schema form', () => {
  it('turns properties into the right controls', () => {
    const fields = fieldsOf(schema)
    expect(fields.map((field) => [field.name, field.kind, field.required])).toEqual([
      ['q', 'text', true],
      ['limit', 'integer', false],
      ['mode', 'choice', false],
      ['exact', 'boolean', false],
      ['tags', 'json', false],
    ])
    expect(fields[1]).toMatchObject({ initial: '12', hint: 'integer · 1–50' })
    expect(fields[2]?.choices).toEqual(['look', 'meaning', 'both'])
  })

  it('reads nullable properties as their real type, with a null default left empty', () => {
    const fields = fieldsOf({
      type: 'object',
      properties: {
        days: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }], default: null, description: 'Window.' },
        sort: { anyOf: [{ type: 'string', enum: ['newest', 'best'] }, { type: 'null' }], default: null },
      },
    })
    expect(fields.map((field) => [field.name, field.kind, field.initial, field.description])).toEqual([
      ['days', 'integer', '', 'Window.'],
      ['sort', 'choice', '', null],
    ])
    expect(argumentsOf(fields, Object.fromEntries(fields.map((field) => [field.name, field.initial]))).args).toEqual({})
  })

  it('reads the form back as typed arguments, leaving empty optional fields out', () => {
    const fields = fieldsOf(schema)
    expect(argumentsOf(fields, { q: 'bird mark', limit: '5', mode: '', exact: 'true', tags: '["a"]' })).toEqual({
      args: { q: 'bird mark', limit: 5, exact: true, tags: ['a'] },
      errors: {},
    })
    expect(argumentsOf(fields, { q: '', limit: '2.5', tags: '[oops' }).errors).toEqual({
      q: 'Required.',
      limit: 'A whole number.',
      tags: 'Not valid JSON.',
    })
  })

  it('fills the form from a past call', () => {
    const fields = fieldsOf(schema)
    expect(valuesOf(fields, { q: 'x', tags: ['a', 'b'] })).toMatchObject({
      q: 'x',
      limit: '12',
      tags: '[\n  "a",\n  "b"\n]',
    })
  })
})
