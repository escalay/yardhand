import { describe, expect, it } from 'vitest'
import { createTraceSender } from './traces.js'

describe('trace sender', () => {
  it('batches call metadata to Langfuse and never sends arguments or results', async () => {
    const bodies: unknown[] = []
    const sender = createTraceSender({
      baseUrl: 'https://langfuse.example.test/',
      publicKey: 'pk',
      secretKey: 'sk',
      fetchImpl: (async (url: string, init: RequestInit) => {
        expect(url).toBe('https://langfuse.example.test/api/public/ingestion')
        expect((init.headers as Record<string, string>).authorization).toBe(
          `Basic ${Buffer.from('pk:sk').toString('base64')}`,
        )
        bodies.push(JSON.parse(String(init.body)))
        return new Response('{}', { status: 207 })
      }) as never,
    })
    sender.send({
      callId: 'call_1',
      client: 'laptops',
      tool: 'cookbook.search_recipes',
      upstream: 'cookbook',
      via: 'mcp',
      status: 'ok',
      durationMs: 12,
      resultBytes: 300,
      at: '2026-11-07T00:00:00Z',
    })
    await sender.flush()
    sender.stop()
    const [batch] = bodies as { batch: { type: string; body: Record<string, unknown> }[] }[]
    expect(batch?.batch[0]).toMatchObject({
      type: 'trace-create',
      body: {
        id: 'call_1',
        userId: 'laptops',
        environment: 'yardhand',
        metadata: { tool: 'cookbook.search_recipes', status: 'ok' },
      },
    })
    expect(Object.keys(batch?.batch[0]?.body ?? {})).not.toContain('input')
    expect(Object.keys(batch?.batch[0]?.body ?? {})).not.toContain('output')
    await sender.flush()
    expect(bodies).toHaveLength(1)
  })
})

describe('CSV cells', () => {
  it('quotes what needs quoting and defuses spreadsheet formulas', async () => {
    const { csvCell } = await import('./handlers.js')
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a, b')).toBe('"a, b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell(42)).toBe('42')
  })
})
