import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DIMENSIONS, SpendCapError } from '../../kit/vectors/index.js'
import { barsFor, createMeaningSearch, fuse, MIN_ROWS } from './meaning.js'
import type { ToolsRepo } from './repo.js'

describe('fuse', () => {
  it('ranks names found by both searches first, then the rest by their best rank', () => {
    expect(
      fuse(
        [
          ['a', 'b', 'c'],
          ['c', 'd', 'a'],
        ],
        10,
      ),
    ).toEqual(['a', 'c', 'b', 'd'])
    expect(fuse([['a'], []], 10)).toEqual(['a'])
    expect(fuse([['a', 'b', 'c']], 2)).toEqual(['a', 'b'])
  })
})

const axis = (index: number) => {
  const vector = new Float32Array(DIMENSIONS)
  vector[index] = 1
  return vector
}
const nameOf = (row: number) => `shelf.tool_${String(row).padStart(3, '0')}`
/** A search over `rows` tools: the first `matching` are exactly what "on topic" asks for, the rest nothing like it. */
const searchOver = (rows: number, matching: number) =>
  createMeaningSearch({
    file: join(mkdtempSync(join(tmpdir(), 'meaning-')), 'tools.jsonl'),
    tools: {
      listLive: async () =>
        Array.from({ length: rows }, (_, row) => ({
          name: nameOf(row),
          upstreamId: 'shelf',
          title: null,
          description: row < matching ? 'on topic' : 'something else',
        })),
    } as unknown as ToolsRepo,
    embed: async (inputs) => ({
      vectors: inputs.map((input) => axis(String(input).includes('on topic') ? 0 : 1)),
      tokens: 0,
      cost: 0,
    }),
    query: async (q) => axis(q === 'on topic' ? 0 : 2),
    log: () => {},
  })
const refreshed = async (rows: number, matching: number) => {
  const search = searchOver(rows, matching)
  await search.refresh()
  return search
}
const everything = { limit: 100, keep: () => true }

describe('standouts', () => {
  it('scores every tool, then keeps to the caller’s: a match stands out however few tools the caller is listed', async () => {
    const search = await refreshed(60, 1)
    expect(await search.standouts('on topic', everything)).toEqual([nameOf(0)])
    const mine = new Set([nameOf(0), nameOf(30), nameOf(59)])
    expect(await search.standouts('on topic', { limit: 100, keep: (name) => mine.has(name) })).toEqual([nameOf(0)])
    expect(await search.standouts('on topic', { limit: 100, keep: (name) => name !== nameOf(0) })).toEqual([])
  })

  it('answers nothing for a question no tool matches, where names() still answers', async () => {
    const search = await refreshed(60, 1)
    expect(await search.standouts('off topic', everything)).toEqual([])
    expect(await search.names('off topic', 5)).toHaveLength(5)
  })

  it('takes a bar of 3 to stand out among fewer than 150 tools, and the kit’s own (3.5) from there', async () => {
    expect([50, 149, 150, 1000].map((rows) => barsFor(rows).stands)).toEqual([3, 3, undefined, undefined])
    // k equal matches among n rows stand √((n − k) / k) above the mean
    const standing = async (rows: number, matches: number) =>
      ((await (await refreshed(rows, matches)).standouts('on topic', everything)) ?? []).length
    // Among sixty: 3.32 for five, 2.75 for seven
    expect([await standing(60, 5), await standing(60, 7)]).toEqual([5, 0])
    // The step at 150: twelve matches stand 3.38 out among 149 and 3.39 among 150; eleven stand 3.55 out among 150
    expect([await standing(149, 12), await standing(150, 12), await standing(150, 11)]).toEqual([12, 0, 11])
  })

  it('takes a lower bar for keyword hits, which rises with the catalog: 1 under 150 tools, 1.5 under 1000, then 2', async () => {
    expect([50, 149, 150, 999, 1000, 5000].map((rows) => barsFor(rows).found)).toEqual([1, 1, 1.5, 1.5, 2, 2])
    const found = { limit: 5000, keep: () => true, found: true }
    // k equal matches among n rows stand √((n − k) / k) above the mean
    const passing = async (rows: number, matches: number) =>
      ((await (await refreshed(rows, matches)).standouts('on topic', found)) ?? []).length
    // Among sixty: 1.03 for twenty-nine, 0.97 for thirty-one
    expect([await passing(60, 29), await passing(60, 31)]).toEqual([29, 0])
    // The step at 150: forty-seven matches stand 1.47 out among 149 and 1.48 among 150
    expect([await passing(149, 47), await passing(150, 47), await passing(150, 46)]).toEqual([47, 0, 46])
    // The step at 1000: 201 matches stand 1.99 out among 999 and among 1000; 199 stand 2.01 out
    expect([await passing(999, 201), await passing(1000, 201), await passing(1000, 199)]).toEqual([201, 0, 199])
    const hits = new Set([nameOf(3), nameOf(40)])
    expect(await (await refreshed(60, 29)).standouts('on topic', { ...found, keep: (name) => hits.has(name) })).toEqual(
      [nameOf(3)],
    )
  })

  it('has no bar below MIN_ROWS tools or before the first refresh: null, and names() answers as before', async () => {
    expect(MIN_ROWS).toBe(50)
    const small = await refreshed(MIN_ROWS - 1, 1)
    expect(await small.standouts('on topic', everything)).toBeNull()
    expect(await small.standouts('off topic', everything)).toBeNull()
    expect(await small.names('on topic', 3)).toEqual([nameOf(0), nameOf(1), nameOf(2)])
    expect(await (await refreshed(MIN_ROWS, 1)).standouts('on topic', everything)).toEqual([nameOf(0)])
    expect(await searchOver(60, 1).standouts('on topic', everything)).toBeNull()
  })

  it('says which tools it has a vector for: none before the first refresh', async () => {
    const search = await refreshed(60, 1)
    expect([search.has(nameOf(0)), search.has(nameOf(59)), search.has(nameOf(60))]).toEqual([true, true, false])
    expect(searchOver(60, 1).has(nameOf(0))).toBe(false)
  })
})

describe('a refresh that fails or stops', () => {
  const FIRST = 20
  const THEN = 100
  /** A search over sixty tools whose embedder answers from `answers`, one per call, then embeds as it should. */
  const failingFirst = (answers: (() => Promise<never>)[], rows = 60) => {
    let calls = 0
    const search = createMeaningSearch({
      file: join(mkdtempSync(join(tmpdir(), 'meaning-')), 'tools.jsonl'),
      tools: {
        listLive: async () =>
          Array.from({ length: rows }, (_, row) => ({
            name: nameOf(row),
            upstreamId: 'shelf',
            title: null,
            description: row < 100 ? 'on topic' : 'something else',
          })),
      } as unknown as ToolsRepo,
      embed: async (inputs) => {
        const answer = answers[calls++]
        if (answer) return answer()
        return { vectors: inputs.map(() => axis(0)), tokens: 0, cost: 0 }
      },
      query: async () => axis(0),
      log: () => {},
      retryDelays: [FIRST, THEN],
    })
    return Object.assign(search, { calls: () => calls })
  }
  const busy = () => Promise.reject(new Error('OpenRouter 503: busy'))

  it('is tried again after a while, and says meanwhile which tools have no vector and why', async () => {
    const search = failingFirst([busy])
    const before = Date.now()
    await search.refresh()
    expect(search.has(nameOf(0))).toBe(false)
    const status = search.status?.()
    expect(status).toMatchObject({ tools: 60, missing: 60, failed: 'OpenRouter 503: busy' })
    expect(Date.parse(status?.retryAt ?? '')).toBeGreaterThanOrEqual(before + FIRST)
    await vi.waitFor(() => expect(search.has(nameOf(0))).toBe(true))
    expect(search.status?.()).toEqual({ tools: 60, missing: 0, failed: null, retryAt: null })
  })

  it('waits longer each time it fails again, and is tried again after the spend cap stopped it', async () => {
    const capped = () => Promise.reject(new SpendCapError('OpenRouter 402: out of credits'))
    const search = failingFirst([capped, busy])
    await search.refresh()
    expect(search.status?.()).toMatchObject({ missing: 60, failed: 'the key’s spend cap was reached' })
    await vi.waitFor(() => expect(search.calls()).toBe(2))
    await vi.waitFor(() => expect(search.status?.().failed).toBe('OpenRouter 503: busy'), { interval: 1 })
    const second = Date.parse(search.status?.().retryAt ?? '')
    expect(second - Date.now()).toBeGreaterThan(FIRST)
    await vi.waitFor(() => expect(search.has(nameOf(0))).toBe(true))
  })

  it('serves the vectors made before it failed', async () => {
    const late = () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('OpenRouter 500')), 30))
    // Two batches of a hundred: the first is embedded, the second fails
    const search = failingFirst([undefined as never, late], 150)
    await search.refresh()
    expect([search.has(nameOf(0)), search.has(nameOf(120))]).toEqual([true, false])
    expect(search.status?.()).toMatchObject({ tools: 150, missing: 50, failed: 'OpenRouter 500' })
    search.stop?.()
  })

  it('tries no more once stopped: a new key starts its own', async () => {
    const search = failingFirst([busy])
    await search.refresh()
    search.stop?.()
    await new Promise((resolve) => setTimeout(resolve, THEN * 2))
    expect(search.calls()).toBe(1)
    expect(search.status?.().retryAt).toBeNull()
  })
})
