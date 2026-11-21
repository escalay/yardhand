import { describe, expect, it } from 'vitest'
import { packInstructions, readable } from './server.js'

const data = { rows: Array.from({ length: 40 }, (_, n) => ({ id: n, name: `row ${n}` })) }

describe('readable', () => {
  it('sends a tool’s own text without the typed JSON beside it', () => {
    const text = 'Forty rows, the first being row 0 and the last row 39; each has an id and a name to open it by.'
    expect(readable({ content: [{ type: 'text', text }], structuredContent: data })).toEqual({
      content: [{ type: 'text', text }],
    })
  })

  it('keeps the JSON when there is no text, or a text that only says it worked', () => {
    expect(readable({ content: [], structuredContent: data }).structuredContent).toBe(data)
    expect(readable({ content: [{ type: 'text', text: 'Success' }], structuredContent: data }).structuredContent).toBe(
      data,
    )
  })
})

describe('a pack connection’s instructions', () => {
  const pack = { name: 'desk', title: 'Front desk', description: 'Greets for the desk.', playbooks: [], manuals: [] }
  const pin = {
    name: 'greet_from_desk',
    title: null,
    description: 'Greets.\n\nMore.',
    inputSchema: {},
    annotations: {},
  }

  it('say every tool is listed for a key without pins of its own, and name the pack’s connections', () => {
    const told = packInstructions(
      { ...pack, ownPins: false },
      { pins: [pin], readOnly: false, connections: ['- fixture: Fixture (1 tool)'] },
    )
    expect(told).toMatch(/^Front desk: Greets for the desk\.\n\nEvery tool of this pack is listed here/)
    expect(told).toContain('In this pack:\n- fixture: Fixture (1 tool)')
    expect(told).toContain('Listed here:\n- greet_from_desk: Greets.')
    expect(told).not.toContain('read-only')
  })

  it('say the pinned tools are listed and the rest is found, for a key with pins of its own', () => {
    const told = packInstructions({ ...pack, ownPins: true }, { pins: [pin], readOnly: true })
    expect(told).toContain('Your pinned tools are listed here')
    expect(told).toContain('1. search_tools with what you want to do.')
    expect(told).toContain('This key is read-only')
  })

  it('say which of the pack’s names the connection’s own tools hold, and that those run through call_tool', () => {
    const told = packInstructions(
      { ...pack, ownPins: false },
      { pins: [pin], readOnly: false, shadowed: ['search_tools'] },
    )
    expect(told).toContain('Every tool of this pack is listed here')
    expect(told).toContain(
      'Except search_tools: that name is this connection’s own tool here. Run the pack’s tool of that name with call_tool.',
    )
    expect(told).not.toContain('- search_tools:')
    const two = packInstructions(
      { ...pack, ownPins: true },
      { pins: [], readOnly: false, shadowed: ['search_tools', 'call_tool'] },
    )
    expect(two).toContain(
      'Except search_tools, call_tool: those names are this connection’s own tools here. Run the pack’s tools of those names with call_tool.',
    )
  })

  it('say so when nothing is listed: no pin in this pack, or a pack with no tools for this key', () => {
    const none = packInstructions({ ...pack, ownPins: true }, { pins: [], readOnly: false })
    expect(none).toContain('No tool of this pack is listed here. Each is found on demand:')
    expect(none).not.toContain('Listed here:')
    const empty = packInstructions({ ...pack, ownPins: false }, { pins: [], readOnly: false })
    expect(empty).toContain('This pack holds no tools this key can use.')
    expect(empty).not.toContain('Every tool of this pack')
  })
})
