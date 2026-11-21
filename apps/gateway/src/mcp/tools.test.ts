import { describe, expect, it } from 'vitest'
import { countOf, META_TOOLS, metaToolsFor } from './tools.js'

const search = META_TOOLS.find((tool) => tool.name === 'search_tools')
const nothing = { query: 'taxes', hiddenForScope: 0, hint: null, playbooks: [], _embedded: { tools: [] } }
const kit = { name: 'kit', title: 'Kit' }
const read = (json: object) => search?.summarize(json, { query: 'taxes' } as never)

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

describe('the meta-tools over a pack', () => {
  const described = (pack: Parameters<typeof metaToolsFor>[0], name: string) => {
    const tool = metaToolsFor(pack).find((one) => one.name === name)
    if (!tool) throw new Error(`no ${name}`)
    const input = (tool.input as unknown as { shape: Record<string, { description?: string }> }).shape
    return { description: tool.description, name: input.name?.description, uri: input.uri?.description }
  }

  it('word get_playbook for a pack: its playbooks are not all a connection’s', () => {
    const forPack = described(kit, 'get_playbook')
    expect(forPack.description).toBe(
      'A playbook filled in with your arguments: a step-by-step way to do one task with this pack’s tools. search_tools suggests them; follow the steps it returns.',
    )
    expect(forPack.name).toBe('The playbook name as search_tools or the prompt list gives it.')
    expect(JSON.stringify(forPack)).not.toContain('<upstream>-<prompt>')
    // The gateway's own keeps its words
    expect(described(undefined, 'get_playbook').name).toContain('`<upstream>-<prompt>`')
  })

  it('say where a pack’s skill is read, only for a pack that has one', () => {
    const withSkill = described({ ...kit, skill: 'skill://kit/SKILL.md' }, 'read_resource')
    expect(withSkill.description).toContain('or this pack’s skill (skill://kit/SKILL.md)')
    expect(withSkill.uri).toContain('skill://kit/SKILL.md')
    for (const pack of [kit, { ...kit, skill: null }, undefined])
      expect(JSON.stringify(described(pack, 'read_resource'))).not.toContain('skill')
  })
})

describe('search_tools, when nothing matches', () => {
  it('says what the pack covers, and how many groups it left out', () => {
    expect(read({ ...nothing, hint: { pack: kit, covers: ['Inbox', 'Notes'], more: 0 } })).toBe(
      'Nothing in Kit matches "taxes". This pack covers: Inbox, Notes.',
    )
    expect(read({ ...nothing, hint: { pack: kit, covers: ['Inbox', 'Notes'], more: 3 } })).toBe(
      'Nothing in Kit matches "taxes". This pack covers: Inbox, Notes, and 3 more.',
    )
  })

  it('says so when the pack holds no tool this key can use', () => {
    expect(read({ ...nothing, hint: { pack: kit, covers: [], more: 0 } })).toBe(
      'Nothing in Kit matches "taxes". This pack holds no tools this key can use.',
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

  it('says how many matches a read-only key is not shown, one in the singular', () => {
    const plain = 'Try other words, or list_upstreams to see what is connected.'
    expect(read({ ...nothing, hiddenForScope: 1 })).toBe(
      `No tools match.\n\n1 more matching tool changes things and is hidden from this read-only key. ${plain}`,
    )
    expect(read({ ...nothing, hiddenForScope: 2 })).toBe(
      `No tools match.\n\n2 more matching tools change things and are hidden from this read-only key. ${plain}`,
    )
  })

  it('keeps its plain answer without a hint', () => {
    expect(read(nothing)).toBe('No tools match. Try other words, or list_upstreams to see what is connected.')
  })
})
