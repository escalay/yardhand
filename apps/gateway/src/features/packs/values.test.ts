import { describe, expect, it } from 'vitest'
import { namesIn, placeholdersIn, resolveText, resolveValue, variablesFrom } from './values.js'

const variables = { since_days: 7, desk: 'the desk', urgent: true }

describe('placeholdersIn', () => {
  it('names each variable written once, in order', () => {
    expect(placeholdersIn('From {{desk}} to {{ city }}, again {{desk}}')).toEqual(['desk', 'city'])
  })

  it('ignores anything that is not a name', () => {
    expect(placeholdersIn('{{ 1+1 }} {{Desk}} {{}} {{a.b}} {{ two words }} {desk}')).toEqual([])
  })
})

describe('resolveValue', () => {
  it('gives a value that is one placeholder the variable’s own type', () => {
    expect(resolveValue('{{since_days}}', variables)).toEqual({ value: 7, used: ['since_days'], undeclared: [] })
    expect(resolveValue('{{ urgent }}', variables).value).toBe(true)
  })

  it('fills a placeholder inside longer text as text', () => {
    expect(resolveValue('Posted in the last {{since_days}} days, by {{desk}}', variables)).toEqual({
      value: 'Posted in the last 7 days, by the desk',
      used: ['since_days', 'desk'],
      undeclared: [],
    })
  })

  it('walks arrays and objects, and leaves other values as they are', () => {
    expect(resolveValue({ from: ['{{desk}}', 3], within: { days: '{{since_days}}' }, on: null }, variables)).toEqual({
      value: { from: ['the desk', 3], within: { days: 7 }, on: null },
      used: ['desk', 'since_days'],
      undeclared: [],
    })
  })

  it('leaves a word the pack does not declare exactly as written, and says so', () => {
    expect(resolveValue('Hello {{first_name}}, from {{desk}}', variables)).toEqual({
      value: 'Hello {{first_name}}, from the desk',
      used: ['desk'],
      undeclared: ['first_name'],
    })
    expect(resolveValue('{{ first_name }}', variables).value).toBe('{{ first_name }}')
    // A name every object has is not a variable either
    expect(resolveValue('{{constructor}}', variables)).toEqual({
      value: '{{constructor}}',
      used: [],
      undeclared: ['constructor'],
    })
  })
})

describe('resolveText', () => {
  it('fills what the pack declares', () => {
    expect(resolveText('{{since_days}} days', variables)).toEqual({
      text: '7 days',
      used: ['since_days'],
      undeclared: [],
    })
  })
})

describe('namesIn', () => {
  it('names every variable a value writes, however deep', () => {
    expect(namesIn({ a: '{{desk}}', b: ['{{city}}', { c: 'in {{desk}}' }], d: 4 })).toEqual(['desk', 'city'])
  })
})

describe('variablesFrom', () => {
  it('reads stored rows by name, each value with its type', () => {
    expect(
      variablesFrom([
        { name: 'desk', value: '"the desk"' },
        { name: 'since_days', value: '7' },
        { name: 'city', value: null },
      ]),
    ).toEqual({ desk: 'the desk', since_days: 7 })
  })
})
