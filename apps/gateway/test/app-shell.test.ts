/**
 * The routes behind the app's frame: numbers for a window and a scope, the call log by pack and as CSV, the search
 * log with what came of each search, and the owner looking at tools as one of their keys would.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-the-shell'
const upstream = await startUpstream({ token: 'fixture-token' })
const app = await createApp({
  db: await testDb(),
  env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
})
afterAll(() => upstream.close())

type Init = { method?: string; body?: unknown; headers?: Record<string, string> }
const request = (key: string, path: string, init: Init = {}) =>
  app.request(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
const api = async (key: string, path: string, init?: Init) => {
  const response = await request(key, path, init)
  return { status: response.status, json: (await response.json().catch(() => null)) as any }
}
const owner = (path: string, init?: Init) => api(OWNER, path, init)
const call = (key: string, tool: string, text: string, via = 'mcp') =>
  api(key, '/api/calls', { method: 'POST', body: { tool, arguments: { text } }, headers: { 'x-gateway-via': via } })

let packKey = ''
let packKeyId = ''
let laptop = ''
let laptopId = ''
beforeAll(async () => {
  expect(
    (
      await owner('/api/upstreams', {
        method: 'POST',
        body: { id: 'fixture', title: 'Fixture', url: upstream.url, auth: { type: 'bearer', value: 'fixture-token' } },
      })
    ).status,
  ).toBe(201)
  await owner('/api/packs', { method: 'POST', body: { name: 'quiet', title: 'Quiet', description: 'Only echo.' } })
  await owner('/api/packs/quiet', { method: 'PATCH', body: { add: { tools: [{ name: 'fixture.echo' }] } } })
  await owner('/api/packs/quiet/tools/fixture.echo/wording', {
    method: 'PUT',
    body: { description: 'Says it back, quietly.' },
  })
  const made = (
    await owner('/api/clients', { method: 'POST', body: { name: 'quiet session', scope: 'read', pack: 'quiet' } })
  ).json
  packKey = made.key
  packKeyId = made.id
  const other = (
    await owner('/api/clients', { method: 'POST', body: { name: 'laptop', scope: 'write', upstreams: 'all' } })
  ).json
  laptop = other.key
  laptopId = other.id
  await call(packKey, 'fixture.echo', 'one')
  await call(packKey, 'fixture.shout', 'refused, not in the pack')
  await call(laptop, 'fixture.shout', 'two', 'rest')
  await call(laptop, 'fixture.echo', 'three', 'rest')
  await api(laptop, '/api/tools?q=echo')
  await call(laptop, 'fixture.echo', 'found it')
  await api(laptop, '/api/tools?q=send a fax')
})

describe('numbers for a window', () => {
  it('counts the window with its problems, a series, and ranked tools and agents', async () => {
    const { status, json } = await owner('/api/overview/stats?range=24h')
    expect(status).toBe(200)
    expect(json.tiles.now).toMatchObject({ calls: 5, problems: 1, searches: 2, found: 1 })
    expect(json.tiles.before).toMatchObject({ calls: 0, searches: 0 })
    expect(json.series).toHaveLength(24)
    expect(json.tools[0]).toEqual({ name: 'fixture.echo', calls: 3, problems: 0 })
    expect(json.agents.map((agent: { name: string }) => agent.name).sort()).toEqual(['laptop', 'quiet session'])
    expect(json.unanswered.map((search: { query: string }) => search.query)).toEqual(['send a fax'])
  })

  it('scopes to a pack’s keys, to one agent, and to a door', async () => {
    expect((await owner('/api/overview/stats?range=7d&pack=quiet')).json.tiles.now).toMatchObject({
      calls: 2,
      problems: 1,
      searches: 0,
    })
    expect((await owner(`/api/overview/stats?client=${laptopId}`)).json.tiles.now).toMatchObject({
      calls: 3,
      searches: 2,
    })
    expect((await owner('/api/overview/stats?via=rest')).json.tiles.now.calls).toBe(2)
    expect((await owner('/api/overview/stats?pack=nope')).status).toBe(404)
    expect((await api(laptop, '/api/overview/stats')).status).toBe(403)
  })
})

describe('the call log', () => {
  it('filters to a pack’s keys', async () => {
    const calls = (await owner('/api/calls?pack=quiet')).json._embedded.calls
    expect(calls.map((row: { clientId: string }) => row.clientId)).toEqual([packKeyId, packKeyId])
    expect(calls[0].traceUrl).toBeNull()
  })

  it('exports as CSV', async () => {
    await call(laptop, 'fixture.echo', 'four')
    const response = await request(OWNER, `/api/calls/export?client=${laptopId}`)
    expect(response.headers.get('content-type')).toContain('text/csv')
    const [header, ...lines] = (await response.text()).split('\n')
    expect(header).toBe('created_at,client,tool,kind,upstream,via,status,duration_ms,result_bytes,error,id')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain(',laptop,fixture.echo,tool,fixture,mcp,ok,')
    expect((await request(laptop, '/api/calls/export')).status).toBe(403)
  })
})

describe('the search log', () => {
  it('says what each search found and what the agent called next', async () => {
    const log = (await owner('/api/searches?days=1')).json._embedded.searches
    expect(log).toEqual([
      expect.objectContaining({ query: 'send a fax', client: 'laptop', followedBy: null }),
      expect.objectContaining({ query: 'echo', followedBy: 'fixture.echo' }),
    ])
    expect((await owner('/api/searches?unanswered=true')).json._embedded.searches).toHaveLength(1)
    expect((await owner('/api/searches?pack=quiet')).json._embedded.searches).toEqual([])
  })
})

describe('tools as a key sees them', () => {
  it('shows the pack’s tools in its wording, hides what a read-only key can’t run, and logs no search', async () => {
    const seen = (await owner(`/api/tools?as=${packKeyId}`)).json._embedded.tools
    expect(seen.map((tool: { name: string }) => tool.name)).toEqual(['fixture.echo'])
    expect(seen[0].summary).toBe('Says it back, quietly.')
    expect((await owner(`/api/tools/fixture.echo?as=${packKeyId}`)).json.description).toBe('Says it back, quietly.')
    const before = (await owner('/api/searches?days=1')).json.count
    await owner(`/api/tools?as=${laptopId}&q=shout`)
    expect((await owner('/api/searches?days=1')).json.count).toBe(before)
    expect((await owner(`/api/tools?as=${laptopId}`)).json._embedded.tools.length).toBeGreaterThan(1)
  })

  it('is the owner’s only', async () => {
    expect((await api(laptop, `/api/tools?as=${packKeyId}`)).status).toBe(403)
    expect((await owner('/api/tools?as=cl_nobody')).status).toBe(409)
  })
})
