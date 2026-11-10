import { describe, expect, it } from 'vitest'
import type { Probe } from '@/api/client'
import { draftOf, ID_PATTERN, offersLine, parseConnectionTab, shortTitleOf, stageOf } from './connections.rules'

const base: Probe = {
  url: 'https://mcp.example.test/mcp',
  reachable: true,
  kind: 'mcp',
  auth: { needed: 'none', accepted: true },
  server: null,
  instructions: null,
  http: null,
  suggested: { id: 'example', title: 'Example' },
  toolCount: 3,
  tools: [],
  offers: { manuals: 0, playbooks: 0, links: 0 },
  problem: null,
  _links: {} as Probe['_links'],
}

describe('adding a connection', () => {
  it('knows what to ask next', () => {
    expect(stageOf(undefined)).toBe('address')
    expect(stageOf({ ...base, reachable: false, kind: null })).toBe('unusable')
    expect(stageOf({ ...base, auth: { needed: 'oauth', accepted: false }, toolCount: null })).toBe('oauth')
    expect(stageOf({ ...base, kind: null, auth: { needed: 'key', accepted: false }, toolCount: null })).toBe('key')
    expect(stageOf(base)).toBe('ready')
  })

  it('builds the upstream from the choices', () => {
    expect(draftOf({ probe: base, id: 'example', title: '', trust: 'review', key: null })).toEqual({
      id: 'example',
      title: 'example',
      kind: 'mcp',
      url: base.url,
      trust: 'review',
      enabled: true,
      linkProxy: true,
      auth: { type: 'none' },
    })
    const rest = { ...base, kind: 'http' as const, http: { spec: 'https://api.example.test/openapi.json' } }
    expect(
      draftOf({
        probe: rest,
        id: 'api',
        title: 'API',
        trust: 'trusted',
        key: { style: 'header', header: 'x-api-key', value: 's3cret' },
      }),
    ).toMatchObject({
      kind: 'http',
      http: { spec: rest.http.spec },
      auth: { type: 'header', header: 'x-api-key', value: 's3cret' },
    })
    expect(ID_PATTERN.test('Bad Id')).toBe(false)
    expect(ID_PATTERN.test('notion-2')).toBe(true)
  })
})

describe('short titles', () => {
  it('keeps the name and drops the explanation', () => {
    expect(shortTitleOf('notes: search and read (titles, bodies, tags)')).toBe('notes')
    expect(shortTitleOf('Docs (docs.example.test)')).toBe('Docs')
    expect(shortTitleOf('Acme themes: website themes, sections')).toBe('Acme themes')
    expect(shortTitleOf('Cookbook recipe library')).toBe('Cookbook recipe library')
    expect(shortTitleOf('example.gallery mirror')).toBe('example.gallery mirror')
  })
})

describe('what a connection offers besides tools', () => {
  it('says it in a few words, or nothing', () => {
    expect(offersLine({ manuals: 1, playbooks: 3, links: 2 })).toBe('a manual, 3 playbooks, 2 kinds of link')
    expect(offersLine({ manuals: 0, playbooks: 1, links: 0 })).toBe('1 playbook')
    expect(offersLine({ manuals: 0, playbooks: 0, links: 0 })).toBeNull()
  })

  it('keeps only a known tab in the address', () => {
    expect(parseConnectionTab({ tab: 'manual' })).toEqual({ tab: 'manual' })
    expect(parseConnectionTab({ tab: 'accounts' })).toEqual({ tab: 'accounts' })
    expect(parseConnectionTab({ tab: 'tools' })).toEqual({})
    expect(parseConnectionTab({ tab: 'nope' })).toEqual({})
  })
})
