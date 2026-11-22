import { describe, expect, it } from 'vitest'
import { OWNER } from '../clients/principals.js'
import { rehearsalPrincipal, rehearses } from './rehearsal.js'

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

describe('whom a rehearsal runs as', () => {
  const pack = { id: 'pk_porch', name: 'porch', title: 'Porch', description: 'Greets guests.' }
  const contents = (value: string | null) => ({
    tools: [
      {
        packId: pack.id,
        name: 'fixture.greet',
        toolName: 'fixture.greet',
        position: 0,
        description: null,
        basedOn: null,
        reason: 'picked' as const,
        via: null,
        fixed: null,
        defaults: null,
        person: JSON.stringify({ from: '{{greeter}}' }),
      },
    ],
    variables: [{ packId: pack.id, name: 'greeter', value, description: null, position: 0 }],
    playbooks: [],
    manuals: [],
    docs: [],
  })

  it('is no person: an input each person fills takes the pack’s value, else the tool’s own default', () => {
    const principal = rehearsalPrincipal(pack, contents(JSON.stringify('the desk')))
    // The owner's id, which no client has, so no one's values are read for it
    expect([principal.id, principal.owner, principal.scope]).toEqual([OWNER.id, false, 'read'])
    expect(principal.pack?.tools.get('fixture.greet')).toMatchObject({ fixed: { from: 'the desk' }, unset: [] })
    const none = rehearsalPrincipal(pack, contents(null))
    expect(none.pack?.tools.get('fixture.greet')).toMatchObject({ fixed: {}, unset: ['from'] })
  })
})
