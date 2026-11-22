import { describe, expect, it } from 'vitest'
import { rehearses } from './rehearsal.js'

const tool = (extra: Partial<Parameters<typeof rehearses>[0]> = {}) => ({
  annotations: { readOnlyHint: true },
  access: null,
  remoteName: 'list_menus',
  route: 'GET /api/menus',
  ...extra,
})

describe('what a rehearsal runs', () => {
  it('runs a tool whose hints say it only reads', () => {
    expect(rehearses(tool())).toBe(true)
    expect(rehearses(tool({ route: null }))).toBe(true)
  })

  it('never runs one that changes things by its hints, even set to read by the owner', () => {
    expect(rehearses(tool({ annotations: {} }))).toBe(false)
    expect(rehearses(tool({ annotations: {}, access: 'read' }))).toBe(false)
    expect(rehearses(tool({ annotations: { readOnlyHint: true, destructiveHint: true } }))).toBe(false)
  })

  it('never runs one the owner set to write or switched off, or whose route is not a read', () => {
    expect(rehearses(tool({ access: 'write' }))).toBe(false)
    expect(rehearses(tool({ access: 'off' }))).toBe(false)
    for (const route of ['POST /api/menus', 'put /api/menus/1', 'PATCH /api/menus/1', 'DELETE /api/menus/1'])
      expect(rehearses(tool({ route }))).toBe(false)
  })
})
