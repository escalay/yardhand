/**
 * End to end, the API the browser app stands on: look before adding, sign in without Access, the overview, live
 * events, the call log's filters, agent setup, batch reviews, what agents looked for, and the front door.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { fakeMeaning } from './fixtures/meaning.js'
import { startOAuthUpstream } from './fixtures/oauth-upstream.js'
import { startRest } from './fixtures/rest.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-the-app'
const web = mkdtempSync(join(tmpdir(), 'gateway-web-'))
writeFileSync(join(web, 'index.html'), '<!doctype html><html><head></head><body><div id="root">app</div></body></html>')
writeFileSync(join(web, 'landing.html'), '<!doctype html><html><head></head><body>landing</body></html>')

const upstream = await startUpstream({ token: 'fixture-token' })
const rest = await startRest({ key: 'rest-secret' })
const secure = await startOAuthUpstream()
const db = await testDb()
const app = await createApp({
  db,
  env: {
    API_KEYS: `owner:${hashApiKey(OWNER)}`,
    GATEWAY_MASTER_KEY: randomBytes(32).toString('base64'),
    OAUTH_SIGNING_KEY: undefined,
    WEB_DIR: web,
  },
  meaning: fakeMeaning(db),
})
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
await new Promise<void>((resolve) => server.once('listening', () => resolve()))
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
afterAll(async () => {
  await upstream.close()
  await rest.close()
  await secure.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

type Init = { method?: string; body?: unknown; headers?: Record<string, string> }
const request = async (path: string, init: Init = {}) => {
  const response = await app.request(path, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const type = response.headers.get('content-type') ?? ''
  return {
    status: response.status,
    headers: response.headers,
    json: (type.includes('json') ? await response.json() : null) as any,
    text: type.includes('json') ? '' : await response.text(),
  }
}
const api = (key: string, path: string, init: Init = {}) =>
  request(path, { ...init, headers: { authorization: `Bearer ${key}`, ...init.headers } })
const owner = (path: string, init: Init = {}) => api(OWNER, path, init)

describe('a fresh gateway', () => {
  it('starts setup at connecting a server', async () => {
    const { status, json } = await owner('/api/overview')
    expect(status).toBe(200)
    expect(json.setup).toMatchObject({ done: 0, total: 5, complete: false, next: 'connect' })
    expect(json.calls.hourly).toHaveLength(24)
    expect(json.calls.daily).toHaveLength(7)
    expect(json.nudges).toEqual([])
  })
})

describe('looking before adding', () => {
  it('says a bearer MCP server wants a key, then lists its tools with one', async () => {
    const bare = await owner('/api/upstreams/probe', { method: 'POST', body: { url: upstream.url } })
    expect(bare.json).toMatchObject({ reachable: true, auth: { needed: 'key', accepted: false }, toolCount: null })
    expect(bare.json.problem).toMatch(/key/)
    const keyed = await owner('/api/upstreams/probe', {
      method: 'POST',
      body: { url: upstream.url, auth: { type: 'bearer', value: 'fixture-token' } },
    })
    expect(keyed.json).toMatchObject({
      kind: 'mcp',
      auth: { needed: 'key', accepted: true },
      toolCount: 2,
      instructions: 'Fixture upstream: echo reads, shout writes.',
      problem: null,
    })
    expect(keyed.json.tools.map((tool: { name: string; readOnly: boolean }) => [tool.name, tool.readOnly])).toEqual([
      ['echo', true],
      ['shout', false],
    ])
    expect(keyed.json.suggested.id).toBe('127')
  })

  it('finds a REST API’s OpenAPI spec beside its URL', async () => {
    const { json } = await owner('/api/upstreams/probe', {
      method: 'POST',
      body: { url: rest.url, auth: { type: 'header', header: 'x-api-key', value: 'rest-secret' } },
    })
    expect(json).toMatchObject({ kind: 'http', http: { spec: `${rest.url}/openapi.json` }, toolCount: 3 })
  })

  it('spots an OAuth server and an address where nothing answers', async () => {
    expect((await owner('/api/upstreams/probe', { method: 'POST', body: { url: secure.url } })).json).toMatchObject({
      kind: 'mcp',
      auth: { needed: 'oauth' },
    })
    const down = await owner('/api/upstreams/probe', { method: 'POST', body: { url: 'http://127.0.0.1:9/mcp' } })
    expect(down.json).toMatchObject({ reachable: false, kind: null })
    expect(down.json.problem).toMatch(/Nothing answered/)
  })

  it('saves nothing and is for the owner only', async () => {
    expect((await owner('/api/upstreams')).json.count).toBe(0)
    const { json: client } = await owner('/api/clients', {
      method: 'POST',
      body: { name: 'prober', scope: 'write', upstreams: 'all' },
    })
    expect((await api(client.key, '/api/upstreams/probe', { method: 'POST', body: { url: rest.url } })).status).toBe(
      403,
    )
    await owner(`/api/clients/${client.id}`, { method: 'DELETE' })
  })
})

describe('signing in without Access', () => {
  const cookieOf = (headers: Headers) => /gw_session=[^;]+/.exec(headers.get('set-cookie') ?? '')?.[0] ?? ''

  it('trades an owner key for a cookie the browser can’t read', async () => {
    expect((await request('/api/session')).json).toMatchObject({ signedIn: false, methods: ['key'] })
    expect((await request('/api/me')).status).toBe(401)
    const signedIn = await request('/api/session', { method: 'POST', body: { key: OWNER } })
    expect(signedIn.status).toBe(200)
    const setCookie = signedIn.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Strict/)
    const cookie = cookieOf(signedIn.headers)
    expect((await request('/api/me', { headers: { cookie } })).json).toMatchObject({ owner: true })
    expect((await request('/api/session', { headers: { cookie } })).json).toMatchObject({
      signedIn: true,
      via: 'session',
    })
    // A write carried by the cookie must come from this site
    const fromElsewhere = await request('/api/pins', {
      method: 'PUT',
      body: { tools: [] },
      headers: { cookie, 'sec-fetch-site': 'cross-site' },
    })
    expect(fromElsewhere.status).toBe(401)
    const fromHere = await request('/api/pins', {
      method: 'PUT',
      body: { tools: [] },
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    })
    expect(fromHere.status).toBe(200)
    expect((await request('/api/session', { method: 'DELETE', headers: { cookie } })).status).toBe(204)
    expect((await request('/api/me', { headers: { cookie } })).status).toBe(401)
  })

  it('refuses client keys and wrong keys', async () => {
    const { json: client } = await owner('/api/clients', {
      method: 'POST',
      body: { name: 'sneaky', scope: 'write', upstreams: 'all' },
    })
    const refused = await request('/api/session', { method: 'POST', body: { key: client.key } })
    expect(refused.status).toBe(401)
    expect(refused.json.detail).toMatch(/owner key/)
    expect((await request('/api/session', { method: 'POST', body: { key: 'not-a-real-key' } })).status).toBe(401)
    await owner(`/api/clients/${client.id}`, { method: 'DELETE' })
  })
})

describe('the front door', () => {
  it('serves the landing page, the app’s pages without a key, and keeps data and the OAuth callback gated', async () => {
    expect((await request('/')).text).toContain('landing')
    const page = await request('/app/tools/fixture.echo')
    expect(page.status).toBe(200)
    expect(page.text).toContain('id="root"')
    expect((await request('/app')).status).toBe(200)
    expect((await request('/app/connect/callback?code=x&state=y')).status).toBe(401)
    expect((await request('/api/tools')).status).toBe(401)
  })
})

let agentKey = ''
let agentId = ''

describe('the activation path, as Home sees it', () => {
  it('ticks each step as it happens', async () => {
    const made = await owner('/api/upstreams', {
      method: 'POST',
      body: { id: 'fixture', url: upstream.url, auth: { type: 'bearer', value: 'fixture-token' }, trust: 'review' },
    })
    expect(made.status).toBe(201)
    let setup = (await owner('/api/overview')).json.setup
    expect(setup.next).toBe('try')

    // The owner tries a tool in the app
    const tried = await owner('/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.echo', arguments: { text: 'from the app' } },
      headers: { 'x-gateway-via': 'app' },
    })
    expect(tried.status).toBe(200)
    setup = (await owner('/api/overview')).json.setup
    expect(setup.next).toBe('key')

    const { json: client } = await owner('/api/clients', {
      method: 'POST',
      body: { name: 'claude-code', scope: 'write', upstreams: 'all' },
    })
    agentKey = client.key
    agentId = client.id
    expect(client.usage).toEqual({ calls7d: 0, lastCallAt: null, searches7d: 0, found7d: 0 })
    expect((await owner('/api/overview')).json.setup.next).toBe('first-call')

    await api(agentKey, '/api/calls', { method: 'POST', body: { tool: 'fixture.echo', arguments: { text: 'hi' } } })
    const overview = (await owner('/api/overview')).json
    expect(overview.setup.next).toBe('pin')
    expect(overview.firstAgentCallAt).toBeTruthy()
    expect(overview.calls.last24h).toMatchObject({ total: 2, ok: 2 })
    expect(overview.calls.hourly.at(-1).total).toBe(2)
    expect(overview.upstreams).toEqual([
      expect.objectContaining({ id: 'fixture', status: 'live', calls24h: 2, failed24h: 0, toolCount: 2 }),
    ])
    expect(overview.topTools).toEqual([{ name: 'fixture.echo', calls7d: 2 }])

    await owner('/api/pins', { method: 'PUT', body: { tools: ['fixture.echo'] } })
    expect((await owner('/api/overview')).json.setup).toMatchObject({ complete: true, next: null })
  })

  it('shows each agent’s use and last call', async () => {
    const card = (await owner(`/api/clients/${agentId}`)).json
    expect(card.usage.calls7d).toBe(1)
    expect(card.usage.lastCallAt).toBeTruthy()
    expect(card._links.setup.href).toMatch(new RegExp(`/api/clients/${agentId}/setup$`))
  })
})

describe('agent setup', () => {
  it('hands out paste-ready snippets that never hold the key', async () => {
    const { status, json } = await owner(`/api/clients/${agentId}/setup`)
    expect(status).toBe(200)
    expect(json.keyPlaceholder).toBe('<YOUR_KEY>')
    expect(json.surfaces.map((surface: { id: string }) => surface.id)).toEqual([
      'claude-code',
      'cursor',
      'codex',
      'curl',
      'typescript',
    ])
    expect(JSON.stringify(json)).not.toContain(agentKey)
    expect(json.surfaces[0].snippet).toContain('/mcp')
    expect((await api(agentKey, `/api/clients/${agentId}/setup`)).status).toBe(403)
  })
})

describe('the call log', () => {
  it('filters by door, outcome and upstream', async () => {
    await api(agentKey, '/api/calls', { method: 'POST', body: { tool: 'fixture.nope', arguments: {} } })
    const fromApp = (await owner('/api/calls?via=app')).json._embedded.calls
    expect(fromApp).toHaveLength(1)
    expect(fromApp[0]).toMatchObject({ via: 'app', client: 'owner' })
    const refused = (await owner('/api/calls?status=refused,failed')).json._embedded.calls
    expect(refused.map((call: { tool: string }) => call.tool)).toEqual(['fixture.nope'])
    expect((await owner('/api/calls?upstream=fixture')).json._embedded.calls).toHaveLength(2)
    const later = new Date(Date.now() + 60_000).toISOString()
    expect((await owner(`/api/calls?since=${later}`)).json._embedded.calls).toEqual([])
    expect((await owner('/api/calls?status=bogus')).status).toBe(400)
  })

  it('keeps the app door for the owner: a client saying so is still REST', async () => {
    await api(agentKey, '/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.echo', arguments: { text: 'pretend' } },
      headers: { 'x-gateway-via': 'app' },
    })
    expect((await owner(`/api/calls?client=${agentId}&limit=1`)).json._embedded.calls[0].via).toBe('rest')
  })
})

describe('live events', () => {
  it('streams each call to the owner as it lands', async () => {
    const controller = new AbortController()
    const response = await fetch(`${origin}/api/events`, {
      headers: { authorization: `Bearer ${OWNER}` },
      signal: controller.signal,
    })
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    const read = (async () => {
      while (!seen.includes('event: call')) {
        const { value, done } = await reader.read()
        if (done) break
        seen += decoder.decode(value)
      }
    })()
    await api(agentKey, '/api/calls', { method: 'POST', body: { tool: 'fixture.echo', arguments: { text: 'live' } } })
    await read
    controller.abort()
    const data = JSON.parse(/event: call\ndata: (.+)/.exec(seen)?.[1] ?? '{}')
    expect(data).toMatchObject({ tool: 'fixture.echo', client: 'claude-code', status: 'ok', via: 'rest' })
    expect((await api(agentKey, '/api/events')).status).toBe(403)
  })
})

describe('tools as the app lists them', () => {
  it('marks pinned tools and counts the week’s calls for the owner only', async () => {
    const mine = (await owner('/api/tools?limit=1000')).json._embedded.tools
    expect(mine.find((tool: { name: string }) => tool.name === 'fixture.echo')).toMatchObject({
      pinned: true,
      calls7d: 4,
    })
    const theirs = (await api(agentKey, '/api/tools')).json._embedded.tools
    expect(theirs.find((tool: { name: string }) => tool.name === 'fixture.echo').calls7d).toBeNull()
  })
})

describe('reviews in one go', () => {
  it('approves every pending change of one upstream', async () => {
    upstream.state.echoDescription = 'Echoes the text back, louder.'
    upstream.state.whisper = true
    expect((await owner('/api/upstreams/fixture/sync', { method: 'POST' })).json.pending.sort()).toEqual([
      'fixture.echo',
      'fixture.whisper',
    ])
    expect((await owner('/api/overview')).json.nudges[0]).toMatchObject({ kind: 'reviews', href: '/app/tools/reviews' })
    const decided = await owner('/api/reviews', { method: 'POST', body: { decision: 'approve', upstream: 'fixture' } })
    expect(decided.json.count).toBe(2)
    expect(decided.json._embedded.decided.every((entry: { state: string }) => entry.state === 'live')).toBe(true)
    expect((await owner('/api/tools/fixture.echo')).json.description).toBe('Echoes the text back, louder.')
    expect((await owner('/api/reviews')).json.count).toBe(0)
  })
})

describe('what agents looked for', () => {
  it('keeps searches no call followed, grouped and counted', async () => {
    // A search the agent acted on (it called a tool it found) is answered
    await api(agentKey, '/api/tools?q=echo text')
    await api(agentKey, '/api/calls', { method: 'POST', body: { tool: 'fixture.echo', arguments: { text: 'ok' } } })
    // Searches whose tools were never called after are what agents wanted
    await api(agentKey, '/api/tools?q=send gmail')
    await api(agentKey, '/api/tools?q=Send  Gmail')
    // The owner trying search in the app is not demand
    await owner('/api/tools?q=calendar', { headers: { 'x-gateway-via': 'app' } })
    const { json } = await owner('/api/searches/unanswered')
    const queries = json._embedded.searches.map((entry: { query: string }) => entry.query.toLowerCase())
    expect(queries).not.toContain('calendar')
    expect(queries).not.toContain('echo text')
    const gmail = json._embedded.searches.find((entry: { query: string }) => /gmail/i.test(entry.query))
    expect(gmail).toMatchObject({ count: 2, clients: ['claude-code'] })
    expect((await owner('/api/overview')).json.unanswered.length).toBeGreaterThan(0)
  })

  it('measures how often agents found what they searched for, overall and per agent', async () => {
    // Three agent searches so far: one led to a call ("echo text"), two did not ("send gmail" twice)
    const { findability } = (await owner('/api/overview')).json
    expect(findability).toMatchObject({ searches: 3, found: 1, reads: { manual: 0, playbook: 0, link: 0 } })
    expect(findability.rate).toBeCloseTo(1 / 3)
    expect((await owner(`/api/clients/${agentId}`)).json.usage).toMatchObject({ searches7d: 3, found7d: 1 })
  })
})

describe('the gateway itself', () => {
  it('reports its version, storage and which optional parts are on', async () => {
    const { json } = await owner('/api/system')
    expect(json.version).toBeTruthy()
    expect(json.database.bytes).toBeGreaterThan(0)
    expect(json.features).toEqual({ meaningSearch: true, traces: false, access: false, oauth: false, alerts: false })
    expect(json.backups).toEqual([])
  })
})
