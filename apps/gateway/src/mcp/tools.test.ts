import { describe, expect, it } from 'vitest'
import { countOf, META_TOOLS } from './tools.js'

const search = META_TOOLS.find((tool) => tool.name === 'search_tools')
const nothing = { query: 'logos', hiddenForScope: 0, hint: null, playbooks: [], _embedded: { tools: [] } }
const kit = { name: 'kit', title: 'Kit' }
const read = (json: object) => search?.summarize(json, { query: 'logos' } as never)

describe('countOf', () => {
  it('says one thing in the singular', () => {
    expect([countOf(1, 'tool'), countOf(2, 'tool'), countOf(0, 'tool'), countOf(1, 'playbook')]).toEqual([
      '1 tool',
      '2 tools',
      '0 tools',
      '1 playbook',
    ])
  })
})

describe('search_tools, when nothing matches', () => {
  it('says what the pack covers, and how many groups it left out', () => {
    expect(read({ ...nothing, hint: { pack: kit, covers: ['Inbox', 'Talks'], more: 0 } })).toBe(
      'Nothing in Kit matches "logos". This pack covers: Inbox, Talks.',
    )
    expect(read({ ...nothing, hint: { pack: kit, covers: ['Inbox', 'Talks'], more: 3 } })).toBe(
      'Nothing in Kit matches "logos". This pack covers: Inbox, Talks, and 3 more.',
    )
  })

  it('says so when the pack holds no tool this key can use', () => {
    expect(read({ ...nothing, hint: { pack: kit, covers: [], more: 0 } })).toBe(
      'Nothing in Kit matches "logos". This pack holds no tools this key can use.',
    )
  })

  it('cuts a long question, and still suggests a playbook', () => {
    const playbooks = [{ name: 'kit-warm-up', title: 'Kit · Warm up', description: 'A first call.' }]
    const said = read({
      ...nothing,
      query: 'x'.repeat(200),
      playbooks,
      hint: { pack: kit, covers: ['Inbox'], more: 0 },
    })
    expect(said).toContain(`matches "${'x'.repeat(79)}…". This pack covers: Inbox.\n\nPlaybooks made for this`)
    expect(said).toMatch(/kit-warm-up: Kit · Warm up\. A first call\.$/)
  })

  it('keeps its plain answer without a hint', () => {
    expect(read(nothing)).toBe('No tools match. Try other words, or list_upstreams to see what is connected.')
  })
})
