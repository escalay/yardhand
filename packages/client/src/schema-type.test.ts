import { describe, expect, it } from 'vitest'
import { typeOf } from './schema-type.js'

describe('typeOf', () => {
  it('turns tool input schemas into TypeScript types', () => {
    expect(typeOf({ type: 'string' })).toBe('string')
    expect(typeOf({ enum: ['a', 'b'] })).toBe('"a" | "b"')
    expect(typeOf({ type: ['string', 'null'] })).toBe('string | null')
    expect(typeOf({ type: 'array', items: { type: 'integer' } })).toBe('Array<number>')
    expect(typeOf({ type: 'object' })).toBe('Record<string, unknown>')
    expect(
      typeOf({
        type: 'object',
        properties: {
          q: { type: 'string', description: 'What to find.' },
          'page-size': { type: 'integer', default: 10 },
        },
        required: ['q', 'page-size'],
      }),
    ).toBe('{\n  /** What to find. */\n  q: string\n  "page-size"?: number\n}')
    expect(typeOf({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe('string | number')
    expect(typeOf(undefined)).toBe('unknown')
  })
})
