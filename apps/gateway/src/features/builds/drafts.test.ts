/** How a kit answer is read onto the pack: only what the model meant to change, within what the pack's routes take. */
import { describe, expect, it } from 'vitest'
import type { LiveTool } from '../tools/repo.js'
import { applyKit } from './drafts.js'
import type { Draft, DraftTool } from './proposal.js'

const greet = {
  name: 'fixture.greet',
  inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
  versionId: 'tv_greet',
  access: null,
  annotations: { readOnlyHint: true },
}
const held = (wording: string | null): DraftTool => ({
  key: 'fixture.greet',
  name: 'fixture.greet',
  tool: 'fixture.greet',
  live: greet,
  fixed: {},
  defaults: {},
  wording,
})
const pack = (tools: DraftTool[], variables: Draft['variables'] = []): Draft => ({
  name: 'desk',
  title: 'Desk',
  tools,
  variables,
  playbooks: [],
  skill: null,
  heldPlaybooks: [],
  manualPaths: [],
  upstreams: ['fixture'],
})
const OWN = 'My own careful wording for greet.'
const wordingAfter = (wording: unknown) =>
  applyKit(
    pack([held(OWN)]),
    { tools: [{ name: 'fixture.greet', reason: 'keep', ...(wording === undefined ? {} : { wording }) }] },
    [],
  ).draft.tools[0]?.wording

describe('a kit answer on a tool the pack holds', () => {
  it('keeps the owner’s wording when the model leaves it out or answers null', () => {
    expect(wordingAfter(undefined)).toBe(OWN)
    expect(wordingAfter(null)).toBe(OWN)
  })

  it('changes it only to new text, and clears it only for an empty string', () => {
    expect(wordingAfter('Greets a guest from the desk.')).toBe('Greets a guest from the desk.')
    expect(wordingAfter('')).toBeNull()
  })

  it('gives a new tool no wording for an empty string', () => {
    const { draft } = applyKit(pack([]), { tools: [{ name: 'fixture.greet', reason: 'add', wording: '' }] }, [
      greet as unknown as LiveTool,
    ])
    expect(draft.tools[0]?.wording).toBeNull()
  })
})

describe('a kit answer’s variables', () => {
  it('keeps a description to the 400 characters the variables route takes', () => {
    const { draft } = applyKit(
      pack([]),
      { tools: [], variables: [{ name: 'desk_name', value: 'the desk', description: 'w'.repeat(600) }] },
      [],
    )
    expect(draft.variables[0]?.description).toHaveLength(400)
  })

  it('adds none past the 100 a pack holds, and says which were left out', () => {
    const variables = Array.from({ length: 95 }, (_, index) => ({
      name: `held_${index}`,
      value: index,
      description: null,
    }))
    const proposed = Array.from({ length: 10 }, (_, index) => ({ name: `new_${index}`, value: index }))
    const { draft, skipped } = applyKit(
      pack([], variables),
      { tools: [], variables: [{ name: 'held_0', value: 'changed' }, ...proposed] },
      [],
    )
    expect(draft.variables).toHaveLength(100)
    expect(draft.variables[0]).toMatchObject({ name: 'held_0', value: 'changed' })
    expect(skipped.map((entry) => entry.name)).toEqual(['new_5', 'new_6', 'new_7', 'new_8', 'new_9'])
    expect(skipped[0]?.reason).toBe('A pack holds 100 variables at most, so this variable was not added.')
  })
})
