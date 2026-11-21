import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIMENSIONS } from '../../kit/vectors/index.js'
import { createMeaningSearch, fuse, KEYWORD_MIN_Z, MIN_ROWS } from './meaning.js'
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

  it('uses the kit’s own bar (3.5 at this size): four equal matches among sixty stand out, five do not', async () => {
    // k equal matches among n rows stand √((n − k) / k) above the mean: 3.74 for four, 3.32 for five
    expect(await (await refreshed(60, 4)).standouts('on topic', everything)).toHaveLength(4)
    expect(await (await refreshed(60, 5)).standouts('on topic', everything)).toEqual([])
  })

  it('takes a lower bar for keyword hits: eleven equal matches among sixty pass KEYWORD_MIN_Z, thirteen do not', async () => {
    expect(KEYWORD_MIN_Z).toBe(2)
    // 2.11 for eleven, 1.90 for thirteen
    const floor = { ...everything, minZ: KEYWORD_MIN_Z }
    expect(await (await refreshed(60, 11)).standouts('on topic', floor)).toHaveLength(11)
    expect(await (await refreshed(60, 13)).standouts('on topic', floor)).toEqual([])
    const hits = new Set([nameOf(3), nameOf(40)])
    expect(await (await refreshed(60, 11)).standouts('on topic', { ...floor, keep: (name) => hits.has(name) })).toEqual(
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
