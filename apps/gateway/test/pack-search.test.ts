/**
 * Search that can say nothing, on a catalog large enough to tell a match from noise (909 tools): a key finds only what
 * stands out among every tool, or carries the asked words and is near enough in meaning, and a pack's empty search
 * says what the pack covers. A small catalog, and a gateway whose search by meaning fails, search as before. Around the
 * search, a pack key is told only the pack: its connections' counts, no links, its own playbooks.
 */
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import type { MeaningSearch } from '../src/features/tools/meaning.js'
import { type Db, hashApiKey, testDb } from '../src/kit/index.js'
import { fakeMeaning } from './fixtures/meaning.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-pack-search'
const upstream = await startUpstream({ token: 'fixture-token', greeting: true })
afterAll(() => upstream.close())

type Init = { method?: string; body?: unknown }
type Card = { name: string }
/** A gateway with the fixture server connected, and its API as a key sees it. */
const gateway = async <Search extends MeaningSearch>(meaningOf: (db: Db) => Search) => {
  const db = await testDb()
  const meaning = meaningOf(db)
  const app = await createApp({
    db,
    env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
    meaning,
  })
  const api = async (key: string, path: string, init: Init = {}) => {
    const response = await app.request(path, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    return { status: response.status, json: (await response.json().catch(() => null)) as any }
  }
  const made = async (path: string, body: unknown, method = 'POST') => {
    const answer = await api(OWNER, path, { method, body })
    expect([path, answer.status, answer.json?.detail]).toEqual([path, method === 'POST' ? 201 : 200, undefined])
    return answer.json
  }
  const keyFor = async (body: Record<string, unknown>) =>
    (await made('/api/clients', { scope: 'write', ...body })).key as string
  /** The names a search returns, in order. */
  const found = async (key: string, q: string) =>
    ((await api(key, `/api/tools?q=${encodeURIComponent(q)}`)).json._embedded.tools as Card[]).map((tool) => tool.name)
  await made('/api/upstreams', {
    id: 'fixture',
    title: 'Fixture',
    url: upstream.url,
    trust: 'trusted',
    auth: { type: 'bearer', value: 'fixture-token' },
  })
  return { app, api, made, keyFor, found, meaning }
}
type Gateway = Awaited<ReturnType<typeof gateway>>
const REST = { kind: 'http', url: 'http://127.0.0.1:9/api', auth: { type: 'none' }, trust: 'trusted' }
const endpoint = (name: string, description: string) => ({ name, method: 'get', path: `/${name}`, description })

/** `count` GET endpoints, numbered 001 up. */
const numbered = (count: number, each: (n: number) => { name: string; description: string }) =>
  Array.from({ length: count }, (_, index) => {
    const one = each(index + 1)
    return endpoint(`${one.name}_${String(index + 1).padStart(3, '0')}`, one.description)
  })
const KIT_TOOLS = [
  { name: 'fixture.echo' },
  { name: 'fixture.shout' },
  { name: 'fixture.greet', alias: 'greet_from_desk', fixed: { from: 'the desk' } },
  { name: 'fixture.greet', alias: 'greet_from_boss', fixed: { from: 'the boss' } },
]
/** The pack `kit` with the fixture's tools (and `more`), a key locked to it and a key outside packs. */
const withKit = async ({ made, keyFor }: Gateway, more: Record<string, unknown> = {}) => {
  await made('/api/packs', { name: 'kit', title: 'Kit', description: 'Says things back.' })
  await made('/api/packs/kit', { add: { tools: KIT_TOOLS, ...more } }, 'PATCH')
  return {
    kit: await keyFor({ name: 'kit-agent', pack: 'kit' }),
    full: await keyFor({ name: 'laptop', upstreams: 'all' }),
  }
}

const large = await gateway(fakeMeaning)
const server = serve({ fetch: large.app.fetch, hostname: '127.0.0.1', port: 0 })
await new Promise<void>((resolve) => server.once('listening', () => resolve()))
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))
/** The large gateway over MCP, as a key connects to it. */
const mcp = async (key: string) => {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', `http://127.0.0.1:${(server.address() as AddressInfo).port}`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  )
  return client
}
/** What a meta-tool answers, as the agent reads it. */
const said = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  ((await client.callTool({ name, arguments: args })).content as { text?: string }[])
    .map((block) => block.text ?? '')
    .join('\n')
const small = await gateway(fakeMeaning)
const refused = () => Promise.reject(new Error('embedding refused'))
const nearestAsked = { times: 0 }
const broken = await gateway(() => ({
  refresh: async () => {},
  names: () => {
    nearestAsked.times += 1
    return refused()
  },
  standouts: refused,
  has: () => false,
}))
/** Search by meaning that counts the refreshes asked of it and can hold them back, as one that failed or stopped. */
const watched = (db: Db) => {
  const search = fakeMeaning(db)
  const refresh = search.refresh
  const state = { held: false, asked: 0, last: Promise.resolve() }
  return Object.assign(search, {
    state,
    refresh: () => {
      state.asked += 1
      state.last = state.held ? Promise.resolve() : refresh()
      return state.last
    },
  })
}
const behind = await gateway(watched)
/** No bar for most questions, so the words answer; for "murmur" one tool stands out, if the caller may be shown it. */
const crowded = await gateway(() => ({
  refresh: async () => {},
  names: async () => [],
  standouts: async (q, pick) => (q === 'murmur' ? ['zed.whisper_note'].filter(pick.keep) : null),
  has: () => true,
}))

describe('on a large catalog', () => {
  const { app, api, made, keyFor, found } = large
  let kit = ''
  let kitReader = ''
  let notes = ''
  let full = ''
  beforeAll(async () => {
    // 105 tools that say the asked words better than the one the pack holds, which ranks last among them
    await made('/api/upstreams', {
      ...REST,
      id: 'crowd',
      title: 'Crowd',
      http: {
        endpoints: [
          ...numbered(105, (n) => ({ name: 'lamp', description: `Warehouse lamp ${n}.` })),
          endpoint(
            'zz_lookup',
            'Looks up one thing kept in the warehouse by its shelf code, and answers with where it stands, who moved it last and when it is due for a check.',
          ),
        ],
      },
    })
    for (const id of ['filler-a', 'filler-b', 'filler-c', 'filler-d'])
      await made('/api/upstreams', {
        ...REST,
        id,
        http: { endpoints: numbered(200, (n) => ({ name: 'flag', description: `Reads beta flag ${n}.` })) },
      })
    // Playbooks elsewhere that say the asked words better than the pack's own, more than a search reads
    const { catalog } = app.services
    for (const { name } of numbered(205, () => ({ name: 'say-back', description: '' }))) {
      const id = `crowd:playbook:${name}`
      await catalog.create({ id, upstreamId: 'crowd', kind: 'playbook', remoteName: name, name: `crowd-${name}` })
      const content = { kind: 'playbook' as const, prompt: name, title: 'Say a topic back', arguments: [] }
      await catalog.makeLive(
        id,
        await catalog.addVersion(id, { ...content, description: 'Say a topic back.' }, 'pending'),
      )
    }
    ;({ kit, full } = await withKit(large, {
      tools: [...KIT_TOOLS, { name: 'crowd.zz_lookup' }, { name: 'crowd.lamp_001' }],
      playbooks: ['fixture-say-it-back'],
    }))
    kitReader = await keyFor({ name: 'kit-reader', pack: 'kit', scope: 'read' })
    await made('/api/packs', { name: 'notes', title: 'Notes', description: 'Echo, with its manual.' })
    await made('/api/packs/notes', { add: { tools: [{ name: 'fixture.echo' }], manuals: ['fixture'] } }, 'PATCH')
    notes = await keyFor({ name: 'notes-agent', pack: 'notes' })
    await large.meaning.refresh()
    expect((await api(OWNER, '/api/tools?limit=5000')).json.count).toBe(909)
  })

  it('answers nothing for a question nothing matches, and says what the pack covers', async () => {
    const { json } = await api(kit, '/api/tools?q=zzqx')
    expect(json).toMatchObject({
      count: 0,
      hiddenForScope: 0,
      hint: { pack: { name: 'kit', title: 'Kit' }, covers: ['Fixture', 'Crowd', 'Lamps'], more: 0 },
      _embedded: { tools: [] },
    })
    // A key outside packs gets nothing too, and no hint
    expect((await api(full, '/api/tools?q=zzqx')).json).toMatchObject({ count: 0, hint: null })
  })

  it('returns only the tool a paraphrase stands out for, not its nearest neighbours', async () => {
    expect(await found(kit, 'parrot')).toEqual(['fixture.echo'])
    expect(await found(full, 'parrot')).toEqual(['fixture.echo'])
    expect((await api(full, '/api/tools?q=parrot')).json).toMatchObject({ count: 1, hint: null })
  })

  it('counts the tools as the pack names them: one tool under two names is two', async () => {
    const { json } = await api(kit, '/api/tools?q=hello')
    expect(json._embedded.tools.map((tool: Card) => tool.name)).toEqual(['greet_from_desk', 'greet_from_boss'])
    expect(json.count).toBe(2)
    expect((await api(kit, '/api/tools?q=hello&limit=1')).json).toMatchObject({
      count: 1,
      _embedded: { tools: [{ name: 'greet_from_desk' }] },
    })
    expect((await api(kit, '/api/tools?limit=5000')).json.count).toBe(6)
  })

  it('drops a keyword hit that is nowhere near in meaning: one shared word does not answer an off-topic question', async () => {
    // echo and shout both say "text"; neither is about French
    for (const q of ['french text', 'translate text to french'])
      expect((await api(kit, `/api/tools?q=${q}`)).json).toMatchObject({
        count: 0,
        hint: { pack: { name: 'kit' } },
        _embedded: { tools: [] },
      })
    expect(await found(kit, 'echo text')).toEqual(['fixture.echo'])
    expect(await found(full, 'french text')).toEqual([])
  })

  it('keeps a keyword hit that is near enough in meaning without standing out, ranked among the pack’s own tools', async () => {
    // 106 tools are equally about lamps, so none stands out; the pack's two carry an asked word. By words zz_lookup
    // ranks last of its connection's 106, past the hundred a search reads there
    expect(await found(kit, 'warehouse lamp')).toEqual(['crowd.lamp_001', 'crowd.zz_lookup'])
    expect(await found(kit, 'lamp')).toEqual(['crowd.lamp_001'])
    expect(await found(full, 'lamp')).toHaveLength(20)
  })

  it('tells a read-only pack key a match is hidden, not that the pack has nothing', async () => {
    expect((await api(kitReader, '/api/tools?q=yell')).json).toMatchObject({
      count: 0,
      hiddenForScope: 1,
      hint: null,
      _embedded: { tools: [] },
    })
    // What it covers is what this key is listed: shout changes things
    expect((await api(kitReader, '/api/tools?q=zzqx')).json).toMatchObject({
      hiddenForScope: 0,
      hint: { covers: ['Fixture', 'Crowd', 'Lamps'], more: 0 },
    })
  })

  it('gives no hint when the search was narrowed: the rest of the pack was not asked', async () => {
    expect((await api(kit, '/api/tools?q=zzqx&upstream=fixture')).json).toMatchObject({ count: 0, hint: null })
    expect((await api(kit, '/api/tools?q=zzqx&upstream=crowd&group=Lamps')).json).toMatchObject({
      count: 0,
      hint: null,
    })
    expect((await api(kit, '/api/tools')).json.hint).toBeNull()
  })

  it('suggests the pack’s own playbook, however many elsewhere say the words better', async () => {
    const asked = '/api/tools?q=say%20a%20topic%20back'
    expect((await api(kit, asked)).json.playbooks).toEqual([
      expect.objectContaining({ name: 'fixture-say-it-back', title: 'Fixture · Say it back' }),
    ])
    expect((await api(notes, asked)).json.playbooks).toEqual([])
    expect((await api(full, asked)).json.playbooks).toHaveLength(3)
    expect((await api(full, `${asked}&upstream=fixture`)).json.playbooks).toEqual([
      expect.objectContaining({ name: 'fixture-say-it-back' }),
    ])
  })

  it('points a pack key at a manual only when its pack holds it', async () => {
    expect((await api(kit, '/api/tools/fixture.echo')).json.manual).toBeNull()
    expect((await api(notes, '/api/tools/fixture.echo')).json.manual).toBe('gateway://u/fixture/manual')
    expect((await api(full, '/api/tools/fixture.echo')).json.manual).toBe('gateway://u/fixture/manual')
    const set = await api(OWNER, '/api/tools/fixture.echo', { method: 'PATCH', body: { access: null } })
    expect(set.json.manual).toBe('gateway://u/fixture/manual')
  })

  it('says over MCP what the pack covers, and only when the whole pack was asked and nothing matched', async () => {
    const agent = await mcp(kit)
    expect(await said(agent, 'search_tools', { query: 'zzqx' })).toBe(
      'Nothing in Kit matches "zzqx". This pack covers: Fixture, Crowd, Lamps.',
    )
    const plain = 'Try other words, or list_upstreams to see what is connected.'
    expect(await said(agent, 'search_tools', { query: 'zzqx', upstream: 'fixture' })).toBe(`No tools match. ${plain}`)
    await agent.close()
    const reader = await mcp(kitReader)
    expect(await said(reader, 'search_tools', { query: 'yell' })).toBe(
      `No tools match.\n\n1 more matching tool changes things and is hidden from this read-only key. ${plain}`,
    )
    await reader.close()
    const outside = await mcp(full)
    expect(await said(outside, 'search_tools', { query: 'zzqx' })).toBe(`No tools match. ${plain}`)
    await outside.close()
  })

  type UpstreamCard = { id: string; toolCount: number; offers: Record<string, number>; groups: unknown[] }
  /** Each connection a key is listed, with its counts. */
  const cardsOf = async (key: string) =>
    Object.fromEntries(
      ((await api(key, '/api/upstreams')).json._embedded.upstreams as UpstreamCard[]).map((card) => [
        card.id,
        { toolCount: card.toolCount, offers: card.offers },
      ]),
    )

  it('counts on a pack key’s connections only what the pack holds', async () => {
    const cards = await cardsOf(kit)
    expect(cards).toEqual({
      crowd: { toolCount: 2, offers: { manuals: 0, playbooks: 0, links: 0 } },
      // Three tools under four names, one of the connection's two playbooks, and not its manual
      fixture: { toolCount: 4, offers: { manuals: 0, playbooks: 1, links: 0 } },
    })
    // Each number is what the same key's lists hold
    for (const [id, card] of Object.entries(cards)) {
      const counted = async (path: string) => (await api(kit, `${path}?upstream=${id}`)).json.count
      expect([id, await counted('/api/tools')]).toEqual([id, card.toolCount])
      expect([id, await counted('/api/playbooks')]).toEqual([id, card.offers.playbooks])
      expect([id, await counted('/api/manuals')]).toEqual([id, card.offers.manuals])
    }
    expect((await api(kit, '/api/upstreams/fixture')).json).toMatchObject({
      toolCount: 4,
      offers: { manuals: 0, playbooks: 1, links: 0 },
      groups: [],
    })
    // A read-only key is not listed shout, which changes things
    expect((await cardsOf(kitReader)).fixture?.toolCount).toBe(3)
    expect(await cardsOf(notes)).toEqual({ fixture: { toolCount: 1, offers: { manuals: 1, playbooks: 0, links: 0 } } })
  })

  it('keeps a connection’s own counts for a key outside packs', async () => {
    const cards = await cardsOf(full)
    expect(cards.crowd).toEqual({ toolCount: 106, offers: { manuals: 0, playbooks: 205, links: 0 } })
    expect(cards.fixture?.offers).toEqual({ manuals: 1, playbooks: 2, links: 1 })
    expect(cards.fixture?.toolCount).toBe((await api(full, '/api/tools?upstream=fixture&limit=200')).json.count)
  })

  it('prints the pack’s own counts in list_upstreams, and a manual only when the pack holds it', async () => {
    const agent = await mcp(kit)
    const listed = await said(agent, 'list_upstreams')
    expect(listed).toMatch(/^crowd: Crowd, 2 tools$/m)
    expect(listed).toMatch(/^fixture: Fixture, 4 tools, 1 playbook$/m)
    expect(listed).not.toContain('Manual:')
    expect(await said(agent, 'describe_tool', { name: 'fixture.echo' })).not.toContain('has a manual')
    await agent.close()
    const holder = await mcp(notes)
    const held = await said(holder, 'list_upstreams')
    expect(held).toMatch(/^fixture: Fixture, 1 tool$/m)
    expect(held).toContain('Manual: read_resource "gateway://u/fixture/manual"')
    expect(await said(holder, 'describe_tool', { name: 'fixture.echo' })).toContain('has a manual')
    await holder.close()
  })

  it('lists a pack key no links: it opens only the ones its tools hand it', async () => {
    expect((await api(kit, '/api/links')).json).toMatchObject({ count: 0, _embedded: { links: [] } })
    expect((await api(notes, '/api/links?upstream=fixture')).json.count).toBe(0)
    expect((await api(full, '/api/links')).json.count).toBe(1)
  })

  it('searches playbooks among the ones the caller may read', async () => {
    const asked = '/api/playbooks?q=say%20a%20topic%20back'
    const names = async (key: string, more = '') =>
      ((await api(key, `${asked}${more}`)).json._embedded.playbooks as Card[]).map((playbook) => playbook.name)
    expect(await names(kit)).toEqual(['fixture-say-it-back'])
    expect(await names(notes)).toEqual([])
    // Outside a pack, a connection's own playbook is found behind 205 better matches elsewhere
    expect(await names(full, '&upstream=fixture')).toEqual(['fixture-say-it-back'])
    expect(await names(full, '&limit=5')).toHaveLength(5)
  })
})

describe('on a catalog too small to tell a match from noise', () => {
  let kit = ''
  let full = ''
  beforeAll(async () => {
    ;({ kit, full } = await withKit(small))
    await small.meaning.refresh()
  })

  it('searches as before: a paraphrase finds its tool, and the nearest tools follow it', async () => {
    for (const key of [kit, full]) {
      const { json } = await small.api(key, '/api/tools?q=parrot')
      expect(json._embedded.tools[0].name).toBe('fixture.echo')
      expect(json.hint).toBeNull()
    }
    expect(await small.found(kit, 'parrot')).toHaveLength(4)
    expect((await small.found(kit, 'shout'))[0]).toBe('fixture.shout')
  })

  it('counts what a read-only key is not shown as the pack names it: one tool under two names is two', async () => {
    const tools = [
      { name: 'fixture.shout', alias: 'shout_once' },
      { name: 'fixture.shout', alias: 'shout_twice' },
    ]
    await small.made('/api/packs', { name: 'loud', title: 'Loud', description: 'Shouts.' })
    await small.made('/api/packs/loud', { add: { tools } }, 'PATCH')
    const writer = await small.keyFor({ name: 'loud-agent', pack: 'loud' })
    const reader = await small.keyFor({ name: 'loud-reader', pack: 'loud', scope: 'read' })
    expect((await small.api(writer, '/api/tools?q=shout')).json).toMatchObject({ count: 2, hiddenForScope: 0 })
    expect((await small.api(reader, '/api/tools?q=shout')).json).toMatchObject({ count: 0, hiddenForScope: 2 })
  })
})

describe('when search by meaning fails', () => {
  let kit = ''
  let full = ''
  beforeAll(async () => {
    ;({ kit, full } = await withKit(broken))
  })

  it('still searches by words, and a pack that matches nothing still says what it covers', async () => {
    for (const key of [kit, full]) expect(await broken.found(key, 'echoes text')).toContain('fixture.echo')
    // The question's vector was refused once: the nearest tools are not asked for it again
    expect(nearestAsked.times).toBe(0)
    expect(await broken.found(kit, 'shout')).toEqual(['fixture.shout'])
    expect((await broken.api(kit, '/api/tools?q=zzqx')).json).toMatchObject({
      count: 0,
      hint: { pack: { name: 'kit', title: 'Kit' }, covers: ['Fixture'], more: 0 },
    })
  })
})

describe('when a live tool has no vector yet', () => {
  const { api, made, found, meaning } = behind
  let kit = ''
  let full = ''
  beforeAll(async () => {
    await made('/api/upstreams', {
      ...REST,
      id: 'shelf',
      http: { endpoints: numbered(60, (n) => ({ name: 'flag', description: `Reads beta flag ${n}.` })) },
    })
    ;({ kit, full } = await withKit(behind))
    await meaning.refresh()
    // No refresh from here on, as after one that failed or stopped at its budget
    meaning.state.held = true
    await made('/api/upstreams', {
      ...REST,
      id: 'late',
      title: 'Late',
      http: { endpoints: [endpoint('whisper_note', 'Whispers a quiet note.')] },
    })
    await made('/api/packs/kit', { add: { tools: [{ name: 'late.whisper_note' }] } }, 'PATCH')
  })

  it('still finds it by its words and its name: a keyword hit nothing has scored is kept', async () => {
    expect(meaning.has('late.whisper_note')).toBe(false)
    for (const key of [OWNER, full, kit])
      for (const q of ['whisper', 'late.whisper_note', 'whispers a quiet note'])
        expect([q, await found(key, q)]).toEqual([q, ['late.whisper_note']])
    // A hit that has a score is still held to the floor
    expect(meaning.has('fixture.echo')).toBe(true)
    expect(await found(full, 'french text')).toEqual([])
  })

  it('embeds a tool the owner approves, so search by meaning finds it', async () => {
    meaning.state.held = false
    const first = endpoint('lamp_switch', 'Switches one lamp.')
    await made('/api/upstreams', { ...REST, id: 'vendor', trust: 'review', http: { endpoints: [first] } })
    await made(
      '/api/upstreams/vendor',
      { http: { endpoints: [first, endpoint('lamp_dimmer', 'Dims one lamp.')] } },
      'PATCH',
    )
    await meaning.state.last
    const reviews = (await api(OWNER, '/api/reviews')).json._embedded.reviews as { name: string; versionId: string }[]
    const waiting = reviews.find((review) => review.name === 'vendor.lamp_dimmer')
    expect(await found(full, 'thing')).toEqual(['vendor.lamp_switch'])
    const asked = meaning.state.asked
    const decided = await api(OWNER, `/api/reviews/${waiting?.versionId}`, {
      method: 'POST',
      body: { decision: 'approve' },
    })
    expect(decided.json.state).toBe('live')
    expect(meaning.state.asked).toBe(asked + 1)
    await meaning.state.last
    expect(await found(full, 'thing')).toContain('vendor.lamp_dimmer')
  })

  it('counts nothing for a pack key on a connection that is switched off, as its lists hold nothing', async () => {
    expect((await api(kit, '/api/upstreams/late')).json.toolCount).toBe(1)
    await made('/api/upstreams/late', { enabled: false }, 'PATCH')
    expect((await api(kit, '/api/upstreams/late')).json).toMatchObject({
      toolCount: 0,
      offers: { manuals: 0, playbooks: 0, links: 0 },
    })
    expect((await api(kit, '/api/tools?upstream=late')).json.count).toBe(0)
  })
})

describe('on a gateway with more tools than one list reads', () => {
  const { api, made, keyFor, found } = crowded
  let full = ''
  let elsewhere = ''
  beforeAll(async () => {
    const flags = numbered(200, (n) => ({ name: 'flag', description: `Reads beta flag ${n}.` }))
    for (const { name } of numbered(25, () => ({ name: 'bulk', description: '' })))
      await made('/api/upstreams', { ...REST, id: name.replace('_', '-'), http: { endpoints: flags } })
    // The last tool by name, past the first 5,000
    await made('/api/upstreams', {
      ...REST,
      id: 'zed',
      http: { endpoints: [endpoint('whisper_note', 'Whispers a quiet note.')] },
    })
    full = await keyFor({ name: 'laptop', upstreams: 'all' })
    elsewhere = await keyFor({ name: 'tablet', upstreams: ['bulk-001'] })
    expect((await api(OWNER, '/api/tools?upstream=bulk-025&limit=1')).json.count).toBe(1)
  })

  it('finds a tool wherever its name sorts, by its words and by meaning', async () => {
    expect(await found(full, 'whispers a quiet note')).toEqual(['zed.whisper_note'])
    expect(await found(full, 'zed.whisper_note')).toEqual(['zed.whisper_note'])
    expect(await found(full, 'murmur')).toEqual(['zed.whisper_note'])
  })

  it('still keeps to the connections the caller is allowed', async () => {
    expect(await found(elsewhere, 'murmur')).toEqual([])
    expect(await found(elsewhere, 'whispers a quiet note')).toEqual([])
    expect(await found(elsewhere, 'flag 007')).toContain('bulk-001.flag_007')
  })
})
