import { describe, expect, it } from 'vitest'
import { readable } from './server.js'

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
