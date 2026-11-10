import { describe, expect, it } from 'vitest'
import type { ToolCard } from '@/api/client'
import { keep, parseToolsSearch } from './tools.rules'

const card = (over: Partial<ToolCard>): ToolCard =>
  ({
    name: 'a.b',
    upstream: 'a',
    title: null,
    summary: '',
    needsWrite: false,
    access: null,
    pinned: false,
    calls7d: 0,
    _links: {},
    ...over,
  }) as ToolCard

describe('tool filters', () => {
  it('reads the address, pinned from Home’s link too', () => {
    expect(parseToolsSearch({ pinned: '1', access: 'off', q: ' send ' })).toEqual({
      q: 'send',
      upstream: undefined,
      access: 'off',
      pinned: true,
    })
    expect(parseToolsSearch({ access: 'everything' }).access).toBeUndefined()
  })
  it('keeps tools by what they may do and whether they are pinned', () => {
    const reads = card({ name: 'r' })
    const writes = card({ name: 'w', needsWrite: true })
    const off = card({ name: 'o', access: 'off', needsWrite: true })
    const pinned = card({ name: 'p', pinned: true })
    const all = [reads, writes, off, pinned]
    expect(all.filter(keep({ access: 'reads' })).map((tool) => tool.name)).toEqual(['r', 'p'])
    expect(all.filter(keep({ access: 'changes' })).map((tool) => tool.name)).toEqual(['w'])
    expect(all.filter(keep({ access: 'off' })).map((tool) => tool.name)).toEqual(['o'])
    expect(all.filter(keep({ pinned: true })).map((tool) => tool.name)).toEqual(['p'])
  })
})
