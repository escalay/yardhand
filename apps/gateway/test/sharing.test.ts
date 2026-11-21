/**
 * Sharing a pack with key-based apps: how long a key works, moving its end, what its holder and the owner are
 * told once it has ended, sharing it with one person and the people it is shared with.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { dayOf, KEY_LIFETIMES } from '../src/features/clients/lifetimes.js'
import { PACK_PATHS } from '../src/features/packs/docs.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-sharing'
const MASTER_KEY = randomBytes(32).toString('base64')
const upstream = await startUpstream({ token: 'fixture-token' })
const db = await testDb()
const app = await createApp({
  db,
  env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: MASTER_KEY },
})
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
await new Promise<void>((resolve) => server.once('listening', () => resolve()))
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
afterAll(async () => {
  await upstream.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

type Init = { method?: string; body?: unknown; headers?: Record<string, string> }
const api = async (key: string, path: string, init: Init = {}) => {
  const response = await app.request(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  return { status: response.status, headers: response.headers, json: (await response.json().catch(() => null)) as any }
}
const owner = (path: string, init?: Init) => api(OWNER, path, init)
const META = [
  'call_tool',
  'describe_tool',
  'get_playbook',
  'get_result',
  'list_upstreams',
  'read_resource',
  'search_tools',
]
/** What a tool answers over MCP, as the agent reads it. */
const said = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  ((await client.callTool({ name, arguments: args })).content as { text?: string }[])
    .map((block) => block.text ?? '')
    .join('\n')
/** What a 2026-07-28 client that still opens with `initialize` is greeted with. */
const greeted = async (key: string, path: string) => {
  const answer = await api(key, path, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28' },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    },
  })
  expect(answer.status).toBe(200)
  return answer.json.result as { serverInfo: { name: string }; instructions: string }
}
const mcp = async (key: string, path = '/mcp') => {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(path, origin), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  )
  return client
}
type Made = { id: string; key: string; app: string | null; expiresAt: string | null }
const keyFor = async (body: Record<string, unknown>) => {
  const made = await owner('/api/clients', { method: 'POST', body: { scope: 'write', ...body } })
  expect(made.status).toBe(201)
  return made.json as Made
}
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** How far from now a time is, to the minute. */
const fromNow = (iso: string | null) => Math.round((Date.parse(iso ?? '') - Date.now()) / 60_000) * 60_000

/** Ends a key a moment ago, as time would; answers the day it ended, as the refusals print it. */
const end = async (id: string) => {
  const at = new Date(Date.now() - 1000).toISOString()
  await db.run(sql`update clients set expires_at = ${at} where id = ${id}`)
  return dayOf(at)
}
/** What a pack key that ended on a day is told, and what a key without a pack is. */
const endedIn = (title: string, day: string) =>
  `Your access to ${title} ended on ${day}. Ask the owner for a new invite.`
const expiredOn = (day: string) => `This key expired on ${day}: the owner can issue a new one in /app.`
const extend = (id: string, expiresIn: string) => owner(`/api/clients/${id}`, { method: 'PATCH', body: { expiresIn } })

beforeAll(async () => {
  const created = await owner('/api/upstreams', {
    method: 'POST',
    body: {
      id: 'fixture',
      title: 'Fixture',
      url: upstream.url,
      trust: 'review',
      auth: { type: 'bearer', value: 'fixture-token' },
    },
  })
  expect(created.status).toBe(201)
  for (const [name, title] of [
    ['loud', 'Loud'],
    ['desk', 'Desk'],
  ]) {
    const made = await owner('/api/packs', {
      method: 'POST',
      body: { name, title, description: 'Say things back.', playbook: 'fixture-say-it-back' },
    })
    expect(made.json.counts).toEqual({ tools: 2, playbooks: 1, manuals: 1 })
  }
})

describe('how long a key works', () => {
  it('takes 30 days, beside 8 hours, a day and a week', async () => {
    for (const [expiresIn, ms] of [
      ['8h', 8 * HOUR],
      ['1d', DAY],
      ['7d', 7 * DAY],
      ['30d', 30 * DAY],
    ] as const)
      expect([
        expiresIn,
        fromNow((await keyFor({ name: `for ${expiresIn}`, pack: 'loud', expiresIn })).expiresAt),
      ]).toEqual([expiresIn, ms])
    expect((await keyFor({ name: 'for good', pack: 'loud', expiresIn: 'never' })).expiresAt).toBeNull()
    expect((await keyFor({ name: 'unsaid', pack: 'loud' })).expiresAt).toBeNull()
    const refused = await owner('/api/clients', {
      method: 'POST',
      body: { name: 'a season', pack: 'loud', expiresIn: '90d' },
    })
    expect(refused.status).toBe(400)
  })
})

describe('Extend', () => {
  it('counts from today and brings an ended key back', async () => {
    const sam = await keyFor({ name: 'Sam', pack: 'loud', expiresIn: '8h' })
    await end(sam.id)
    expect((await api(sam.key, '/p/loud/api/me')).status).toBe(403)
    const week = await extend(sam.id, '7d')
    expect(week.status).toBe(200)
    expect(fromNow(week.json.expiresAt)).toBe(7 * DAY)
    // The same key: the person changes nothing
    expect((await api(sam.key, '/p/loud/api/me')).status).toBe(200)
    expect(fromNow((await extend(sam.id, '30d')).json.expiresAt)).toBe(30 * DAY)
    expect((await extend(sam.id, 'never')).json.expiresAt).toBeNull()
  })

  it('leaves the end alone when a change says nothing about it', async () => {
    const sam = await keyFor({ name: 'Sam', pack: 'loud', expiresIn: '7d' })
    const renamed = await owner(`/api/clients/${sam.id}`, { method: 'PATCH', body: { name: 'Sam at the desk' } })
    expect(renamed.json).toMatchObject({ name: 'Sam at the desk', expiresAt: sam.expiresAt })
  })

  it('never moves an end to a day or less', async () => {
    const sam = await keyFor({ name: 'Sam', pack: 'loud', expiresIn: '8h' })
    for (const expiresIn of ['8h', '1d']) {
      const refused = await extend(sam.id, expiresIn)
      expect([expiresIn, refused.status]).toEqual([expiresIn, 400])
      expect(JSON.stringify(refused.json.errors)).toContain('expiresIn')
    }
    expect((await owner(`/api/clients/${sam.id}`)).json.expiresAt).toBe(sam.expiresAt)
  })

  it('does not bring a revoked key back', async () => {
    const sam = await keyFor({ name: 'Sam', pack: 'loud', expiresIn: '7d' })
    await owner(`/api/clients/${sam.id}`, { method: 'DELETE' })
    expect((await extend(sam.id, '30d')).status).toBe(410)
    expect((await api(sam.key, '/p/loud/api/me')).status).toBe(401)
  })

  it('brings a key whose pack was removed back to nothing, whatever its own allowlist says', async () => {
    const made = await owner('/api/packs', {
      method: 'POST',
      body: { name: 'shed', title: 'Shed', description: 'Soon removed.', playbook: 'fixture-say-it-back' },
    })
    expect(made.status).toBe(201)
    const sam = await keyFor({ name: 'Sam', pack: 'shed', expiresIn: '8h' })
    // Stored, and ignored while the pack decides what the key reaches
    expect((await owner(`/api/clients/${sam.id}`, { method: 'PATCH', body: { upstreams: 'all' } })).status).toBe(200)
    expect((await api(sam.key, '/api/me')).json.upstreams).toEqual(['fixture'])
    await end(sam.id)
    expect((await owner('/api/packs/shed', { method: 'DELETE' })).status).toBe(204)
    expect((await extend(sam.id, '7d')).status).toBe(200)

    const me = await api(sam.key, '/api/me')
    expect([me.status, me.json.pack.name, me.json.upstreams]).toEqual([200, 'removed', []])
    expect((await api(sam.key, '/api/upstreams')).json._embedded.upstreams).toEqual([])
    expect((await api(sam.key, '/api/upstreams/fixture')).status).toBe(404)
    const client = await mcp(sam.key)
    expect(client.getInstructions()).not.toContain('fixture')
    expect(await said(client, 'list_upstreams')).not.toContain('fixture')
    await client.close()
  })
})

describe('where a key runs', () => {
  it('is kept as the owner said it, or not at all', async () => {
    const said = await keyFor({ name: 'Ada', pack: 'loud', app: 'cursor' })
    expect(said.app).toBe('cursor')
    expect((await owner(`/api/clients/${said.id}`)).json.app).toBe('cursor')
    expect((await keyFor({ name: 'Ada', pack: 'loud' })).app).toBeNull()
    const exported = (await owner('/api/config')).json.clients as { id: string; app: string | null }[]
    expect(exported.find((client) => client.id === said.id)?.app).toBe('cursor')
  })

  it('is never claude.ai, which signs in and takes no key', async () => {
    const refused = await owner('/api/clients', {
      method: 'POST',
      body: { name: 'Ada', pack: 'loud', app: 'claude-ai' },
    })
    expect(refused.status).toBe(400)
    expect(JSON.stringify(refused.json.errors)).toContain('app')
  })
})

describe('a key that has ended', () => {
  it('is told the pack, the day and what to do', async () => {
    const sam = await keyFor({ name: 'Sam', pack: 'loud', expiresIn: '30d' })
    const day = await end(sam.id)
    for (const path of ['/api/me', '/p/loud/api/me']) {
      const refused = await api(sam.key, path)
      expect([path, refused.status, refused.json.detail]).toEqual([path, 403, endedIn('Loud', day)])
    }
    expect((await api(sam.key, '/api/me', { headers: { 'x-gateway-pack': 'loud' } })).json.detail).toBe(
      endedIn('Loud', day),
    )
  })

  it('is told the pack it asked for when it opens it, else its default', async () => {
    const ada = await keyFor({ name: 'Ada', packs: ['loud', 'desk'], expiresIn: '7d' })
    const day = await end(ada.id)
    expect((await api(ada.key, '/p/desk/api/me')).json.detail).toBe(endedIn('Desk', day))
    expect((await api(ada.key, '/api/me', { headers: { 'x-gateway-pack': 'desk' } })).json.detail).toBe(
      endedIn('Desk', day),
    )
    expect((await api(ada.key, '/api/me')).json.detail).toBe(endedIn('Loud', day))
    // A pack it never opened: nothing about that pack, only its own ending
    const elsewhere = await api(ada.key, '/p/nope/api/me')
    expect([elsewhere.status, elsewhere.json.detail]).toEqual([403, endedIn('Loud', day)])
  })

  it('is told when it expired, without a pack', async () => {
    const script = await keyFor({ name: 'a script', upstreams: 'all', expiresIn: '1d' })
    const day = await end(script.id)
    const refused = await api(script.key, '/api/me')
    expect([refused.status, refused.json.detail]).toEqual([403, expiredOn(day)])
  })

  it('is refused on every route a pack serves', async () => {
    const sam = await keyFor({ name: 'Sam', pack: 'loud', expiresIn: '30d', resultCap: 1000 })
    // A call whose result is held in pages, and a link its result handed over: both readable while the key works
    const client = await mcp(sam.key, '/p/loud/mcp')
    const cut = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'fixture.echo', arguments: { text: `fixture://notes/7 ${'abcdefghij'.repeat(1000)}` } },
    })
    await client.close()
    const held = cut._meta?.['yardhand/call'] as { id: string }
    const me = (await api(sam.key, '/p/loud/api/me')).json
    const [playbook] = me.pack.playbooks as string[]
    const [manual] = me.pack.manuals as string[]
    const SAMPLES: Record<string, { path: string; body?: unknown }> = {
      'get /api': { path: '/api' },
      'get /api/me': { path: '/api/me' },
      'get /api/tools': { path: '/api/tools?q=echo' },
      'get /api/tools/openapi.json': { path: '/api/tools/openapi.json' },
      'get /api/tools/{name}': { path: '/api/tools/fixture.echo' },
      'post /api/tools/{name}/calls': { path: '/api/tools/fixture.echo/calls', body: { text: 'x' } },
      'get /api/calls': { path: '/api/calls' },
      'post /api/calls': { path: '/api/calls', body: { tool: 'fixture.echo', arguments: { text: 'x' } } },
      'get /api/calls/{id}': { path: `/api/calls/${held.id}` },
      'get /api/calls/{id}/result': { path: `/api/calls/${held.id}/result?page=2` },
      'get /api/upstreams': { path: '/api/upstreams' },
      'get /api/upstreams/{id}': { path: '/api/upstreams/fixture' },
      'get /api/playbooks': { path: '/api/playbooks' },
      'get /api/playbooks/{name}': { path: `/api/playbooks/${playbook}` },
      'get /api/playbooks/{name}/messages': {
        path: `/api/playbooks/${playbook}/messages?arguments=${encodeURIComponent('{"topic":"x"}')}`,
      },
      'get /api/manuals': { path: '/api/manuals' },
      'get /api/manuals/{name}': { path: `/api/manuals/${manual}` },
      'get /api/links': { path: '/api/links' },
      'get /api/resources': { path: `/api/resources?uri=${encodeURIComponent('fixture://notes/7')}` },
    }
    // A route a pack serves later needs a sample here
    expect(Object.keys(SAMPLES).sort()).toEqual(
      Object.entries(PACK_PATHS)
        .flatMap(([path, methods]) => methods.map((method) => `${method} ${path}`))
        .sort(),
    )
    const PAGES = ['/p/loud', '/p/loud/docs', '/p/loud/llms.txt', '/p/loud/openapi.json']
    const ask = (name: string) => {
      const sample = SAMPLES[name] as { path: string; body?: unknown }
      return api(sam.key, `/p/loud${sample.path}`, {
        method: name.split(' ')[0]?.toUpperCase() ?? 'GET',
        ...(sample.body === undefined ? {} : { body: sample.body }),
      })
    }
    // Each is a request the key is answered while it works
    for (const name of Object.keys(SAMPLES)) expect([name, (await ask(name)).status < 400]).toEqual([name, true])
    for (const path of PAGES) expect([path, (await api(sam.key, path)).status < 400]).toEqual([path, true])

    const day = await end(sam.id)
    for (const name of Object.keys(SAMPLES)) {
      const refused = await ask(name)
      expect([name, refused.status, refused.json?.detail]).toEqual([name, 403, endedIn('Loud', day)])
    }
    for (const path of PAGES) {
      const refused = await api(sam.key, path)
      expect([path, refused.status, refused.json?.detail]).toEqual([path, 403, endedIn('Loud', day)])
    }
    expect((await api(sam.key, '/api/events')).status).toBe(403)
    // Not for a link it was never handed: for the ending
    const link = await api(sam.key, '/u/fixture/r/files/a.txt')
    expect([link.status, link.json.detail]).toEqual([403, endedIn('Loud', day)])
  })
})

describe('the owner looking as someone whose access ended', () => {
  it('is told who, which pack, the day and how to extend', async () => {
    const sam = await keyFor({ name: 'Sam', pack: 'loud', expiresIn: '7d' })
    expect((await owner(`/api/tools?pack=loud&as=${sam.id}`)).status).toBe(200)
    const day = await end(sam.id)
    for (const path of [
      `/api/tools?pack=loud&as=${sam.id}`,
      `/api/tools?as=${sam.id}`,
      `/p/loud/api/tools?as=${sam.id}`,
    ]) {
      const refused = await owner(path)
      expect([path, refused.status, refused.json.detail]).toEqual([
        path,
        409,
        `Sam's access to Loud ended on ${day}, so there is nothing to see as Sam: extend it with PATCH /api/clients/${sam.id} {"expiresIn":"30d"}.`,
      ])
    }
    expect((await extend(sam.id, '30d')).status).toBe(200)
    expect((await owner(`/api/tools?pack=loud&as=${sam.id}`)).status).toBe(200)
  })

  it('is told a key without a pack expired', async () => {
    const script = await keyFor({ name: 'a script', upstreams: 'all', expiresIn: '1d' })
    const day = await end(script.id)
    const refused = await owner(`/api/tools?as=${script.id}`)
    expect([refused.status, refused.json.detail]).toEqual([
      409,
      `a script's key expired on ${day}, so there is nothing to see as a script: extend it with PATCH /api/clients/${script.id} {"expiresIn":"30d"}.`,
    ])
  })
})

describe('a key that has ended, over MCP', () => {
  it('still connects at a pack’s address and is told why it can do nothing', async () => {
    const sam = await keyFor({ name: 'Sam', pack: 'loud', expiresIn: '30d' })
    const day = await end(sam.id)
    for (const path of ['/p/loud/mcp', '/mcp/p/loud']) {
      const client = await mcp(sam.key, path)
      expect([path, client.getInstructions()]).toEqual([path, endedIn('Loud', day)])
      // Nothing of the pack: not its name, not its tools
      expect(client.getServerVersion()).toMatchObject({ name: 'yardhand' })
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(META)
      expect(await said(client, 'search_tools', { query: 'echo' })).toContain(endedIn('Loud', day))
      expect(await said(client, 'call_tool', { name: 'fixture.echo', arguments: { text: 'x' } })).toBe(
        endedIn('Loud', day),
      )
      await client.close()
    }
    const modern = await greeted(sam.key, '/p/loud/mcp')
    expect(modern.serverInfo.name).toBe('yardhand')
    expect(modern.instructions).toMatch(new RegExp(`^${endedIn('Loud', day).replaceAll('.', '\\.')}`))
  })

  it('reads the same at plain /mcp', async () => {
    const sam = await keyFor({ name: 'Sam', pack: 'loud', expiresIn: '30d' })
    const script = await keyFor({ name: 'a script', upstreams: 'all', expiresIn: '1d' })
    const whileItWorks = { pack: '', script: '' }
    for (const [name, key] of [
      ['pack', sam.key],
      ['script', script.key],
    ] as const) {
      const client = await mcp(key)
      whileItWorks[name] = client.getInstructions() ?? ''
      await client.close()
    }
    expect(whileItWorks.pack).toMatch(/^Loud: Say things back\./)
    expect(whileItWorks.script).toMatch(/^Yardhand: one MCP server in front of many\./)
    const day = await end(sam.id)
    const scriptDay = await end(script.id)
    const packClient = await mcp(sam.key)
    expect(packClient.getInstructions()).toBe(endedIn('Loud', day))
    await packClient.close()
    const scriptClient = await mcp(script.key)
    expect(scriptClient.getInstructions()).toBe(expiredOn(scriptDay))
    expect(await said(scriptClient, 'call_tool', { name: 'fixture.echo', arguments: { text: 'x' } })).toBe(
      expiredOn(scriptDay),
    )
    await scriptClient.close()
    expect((await greeted(script.key, '/mcp')).instructions).toMatch(/^This key expired on /)
    // Extended, it is served its pack again
    await extend(sam.id, '7d')
    const back = await mcp(sam.key, '/p/loud/mcp')
    expect(back.getInstructions()).toBe(whileItWorks.pack)
    await back.close()
  })

  it('is told of its own pack at the address of one it never opened, and a key that works is refused there', async () => {
    const sam = await keyFor({ name: 'Sam', pack: 'loud', expiresIn: '30d' })
    const refused = await api(sam.key, '/p/desk/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect([refused.status, refused.json.detail]).toEqual([
      403,
      "This key doesn't open the pack desk. It opens loud (/p/loud/mcp).",
    ])
    const day = await end(sam.id)
    const client = await mcp(sam.key, '/p/desk/mcp')
    expect(client.getInstructions()).toBe(endedIn('Loud', day))
    await client.close()
  })
})

type Person = {
  id: string
  name: string
  kind: string
  app: string | null
  scope: string
  createdAt: string
  expiresAt: string | null
  ending: boolean
  ended: boolean
  lastCallAt: string | null
  calls7d: number
  otherPacks: string[]
  oldAddress: { name: string; lastAt: string } | null
  _links: Record<string, { href: string }>
}
type Shared = Person & { key: string; message: string }
/** A pack with the fixture's two tools: `echo` reads, `shout` changes things. */
const packOf = async (name: string, title: string) => {
  const made = await owner('/api/packs', {
    method: 'POST',
    body: { name, title, description: `What ${title} is for.\n\nMore, for agents.`, playbook: 'fixture-say-it-back' },
  })
  expect([made.status, made.json.counts.tools]).toEqual([201, 2])
}
const share = (pack: string, body: Record<string, unknown>) =>
  owner(`/api/packs/${pack}/people`, { method: 'POST', body })
const shared = async (pack: string, body: Record<string, unknown>) => {
  const made = await share(pack, body)
  expect(made.status).toBe(201)
  return made.json as Shared
}
const peopleOf = async (pack: string) => {
  const listed = await owner(`/api/packs/${pack}/people`)
  expect(listed.status).toBe(200)
  return listed.json as { count: number; _embedded: { people: Person[] }; _links: Record<string, { href: string }> }
}
const clientCount = async () => (await owner('/api/clients')).json.count as number
const toolNames = async (key: string, pack: string) =>
  ((await api(key, `/p/${pack}/api/tools`)).json._embedded.tools as { name: string }[]).map((tool) => tool.name)
/** A grant as time would have left it: made `made` ago, ending `ends` from now (in the past when negative). */
const aged = (id: string, made: number, ends: number) =>
  db.run(
    sql`update clients set created_at = ${new Date(Date.now() - made).toISOString()}, expires_at = ${new Date(Date.now() + ends).toISOString()} where id = ${id}`,
  )

describe('sharing a pack with one person', () => {
  beforeAll(() => packOf('garden', 'Garden'))

  it('is read only for 30 days unless said, and answers a message ready to send', async () => {
    const made = await share('garden', { name: 'Sam', app: 'claude-code' })
    expect(made.status).toBe(201)
    const sam = made.json as Shared
    expect(sam).toMatchObject({
      name: 'Sam',
      kind: 'key',
      app: 'claude-code',
      scope: 'read',
      ending: false,
      ended: false,
      calls7d: 0,
      lastCallAt: null,
      otherPacks: [],
      oldAddress: null,
    })
    expect(fromNow(sam.expiresAt)).toBe(30 * DAY)
    expect(sam.key).toMatch(/^gw_/)
    expect(made.headers.get('location')).toBe(`/api/clients/${sam.id}`)
    expect(sam._links).toMatchObject({
      self: { href: `http://localhost/api/clients/${sam.id}` },
      calls: { href: `http://localhost/api/calls?client=${sam.id}` },
      pack: { href: 'http://localhost/api/packs/garden' },
    })
    expect(sam.message.split('\n\n')).toEqual([
      "Hi Sam, I'm sharing Garden with you.",
      'What Garden is for.',
      `You can read with it, but not change anything. It works until ${dayOf(sam.expiresAt ?? '')}.`,
      'Add it to Claude Code (a terminal on the machine that runs Claude Code):',
      `claude mcp add --transport http --scope user gw-garden http://localhost/p/garden/mcp \\\n  --header "Authorization: Bearer ${sam.key}"`,
      expect.stringContaining('gw-garden'),
      'The key is yours alone: keep it to yourself. When it stops working, ask me for a new invite.',
    ])
    // The key is a client like any other, locked to the pack: it opens it, and nothing that changes things
    expect((await owner(`/api/clients/${sam.id}`)).json).toMatchObject({
      pack: 'garden',
      packs: ['garden'],
      pins: null,
    })
    const me = await api(sam.key, '/p/garden/api/me')
    expect([me.status, me.json.pack.name, me.json.scope]).toEqual([200, 'garden', 'read'])
    expect(await toolNames(sam.key, 'garden')).toEqual(['fixture.echo'])
    expect((await api(sam.key, '/p/loud/api/me')).status).toBe(403)

    const ada = await shared('garden', { name: 'Ada', app: 'cursor', scope: 'write' })
    expect(ada.scope).toBe('write')
    expect(ada.message).toContain('You can read and change things with it.')
    expect(await toolNames(ada.key, 'garden')).toEqual(['fixture.echo', 'fixture.shout'])
  })

  it('takes 7 days, 30 days and until revoked, and the short ones still', async () => {
    const MS = { '8h': 8 * HOUR, '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY }
    for (const expiresIn of KEY_LIFETIMES) {
      const made = await shared('garden', { name: `for ${expiresIn}`, expiresIn })
      if (expiresIn === 'never') {
        expect(made.expiresAt).toBeNull()
        expect(made.message).toContain('It works until I end it.')
      } else expect([expiresIn, fromNow(made.expiresAt)]).toEqual([expiresIn, MS[expiresIn]])
      expect((await owner(`/api/clients/${made.id}`, { method: 'DELETE' })).status).toBe(204)
    }
    const refused = await share('garden', { name: 'a season', expiresIn: '90d' })
    expect(refused.status).toBe(400)
    expect(JSON.stringify(refused.json.errors)).toContain('expiresIn')
  })

  it('takes only an app a key is pasted into, or none', async () => {
    const before = await clientCount()
    const refused = await share('garden', { name: 'Lena', app: 'claude-ai' })
    expect(refused.status).toBe(400)
    expect(JSON.stringify(refused.json.errors)).toContain('app')
    expect((await share('garden', { app: 'cursor' })).status).toBe(400)
    expect(await clientCount()).toBe(before)

    for (const body of [{ name: 'Lena', app: null }, { name: 'Lena' }]) {
      const made = await shared('garden', body)
      expect(made.app).toBeNull()
      expect(made.message).toContain(
        `Its address is http://localhost/p/garden/mcp and your key is ${made.key}. Add it to your app as an MCP server and send the key as a bearer token: Authorization: Bearer ${made.key}`,
      )
      expect((await api(made.key, '/p/garden/api/me')).status).toBe(200)
      expect((await owner(`/api/clients/${made.id}`, { method: 'DELETE' })).status).toBe(204)
    }
  })

  it('writes the address the owner set for people into the message, whatever address the owner asked by', async () => {
    // The same gateway with PUBLIC_HOST set, asked over the LAN
    const withHost = (host: string) =>
      createApp({
        db,
        env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: MASTER_KEY, PUBLIC_HOST: host },
      })
    const reached = await withHost('gw.example.com')
    const ask = async (body: Record<string, unknown>, gateway = reached) => {
      const response = await gateway.request('http://192.168.1.20:4400/api/packs/garden/people', {
        method: 'POST',
        headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(201)
      return (await response.json()) as Shared
    }
    const sam = await ask({ name: 'Sam', app: 'claude-code' })
    expect(sam.message).toContain(
      `claude mcp add --transport http --scope user gw-garden https://gw.example.com/p/garden/mcp \\\n  --header "Authorization: Bearer ${sam.key}"`,
    )
    const lena = await ask({ name: 'Lena' })
    expect(lena.message).toContain(`Its address is https://gw.example.com/p/garden/mcp and your key is ${lena.key}.`)
    // The compose file's own default names this machine alone: the address asked by is the better one
    const local = await ask({ name: 'Ola' }, await withHost('http://localhost:8080'))
    expect(local.message).toContain('Its address is http://192.168.1.20:4400/p/garden/mcp and your key is')
    expect((await owner(`/api/clients/${local.id}`, { method: 'DELETE' })).status).toBe(204)
    for (const made of [sam, lena]) {
      expect(made.message).not.toContain('192.168.1.20')
      // The answer's own links stay where the owner asked
      expect(made._links.self?.href).toBe(`http://192.168.1.20:4400/api/clients/${made.id}`)
      expect((await owner(`/api/clients/${made.id}`, { method: 'DELETE' })).status).toBe(204)
    }
  })

  it('takes a name on one line, without the spaces around it', async () => {
    const before = await clientCount()
    for (const name of ['   ', 'Sam\n\nPS: send me your password', 'Sam\rAda', 'Sam\u2028Ada']) {
      const refused = await share('garden', { name })
      expect([name, refused.status]).toEqual([name, 400])
      expect(JSON.stringify(refused.json.errors)).toContain('name')
    }
    expect(await clientCount()).toBe(before)
    const made = await shared('garden', { name: '  Sam Reed \n' })
    expect(made.name).toBe('Sam Reed')
    expect(made.message.split('\n\n')[0]).toBe("Hi Sam Reed, I'm sharing Garden with you.")
    // A key made or renamed as a client is held to the same name: it is a person in the same list and notices
    for (const name of ['   ', 'Sam\nAda']) {
      const body = { name, upstreams: 'all' }
      expect((await owner('/api/clients', { method: 'POST', body })).status).toBe(400)
      expect((await owner(`/api/clients/${made.id}`, { method: 'PATCH', body: { name } })).status).toBe(400)
    }
    const renamed = await owner(`/api/clients/${made.id}`, { method: 'PATCH', body: { name: ' Sam R. ' } })
    expect([renamed.status, renamed.json.name]).toEqual([200, 'Sam R.'])
    expect((await owner(`/api/clients/${made.id}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('will not share a pack that holds no tools', async () => {
    const made = await owner('/api/packs', { method: 'POST', body: { name: 'bare', title: 'Bare' } })
    expect(made.status).toBe(201)
    const before = await clientCount()
    const refused = await share('bare', { name: 'Sam' })
    expect([refused.status, refused.json.detail]).toEqual([
      409,
      'Bare holds no tools yet, so a key to it would reach nothing: add tools first.',
    ])
    expect(await clientCount()).toBe(before)
    expect((await owner('/api/packs/bare', { method: 'DELETE' })).status).toBe(204)
  })

  it('is for the owner only, outside a pack, and for a pack that is there', async () => {
    const before = await clientCount()
    const reader = await keyFor({ name: 'a key of the pack', pack: 'garden' })
    for (const init of [undefined, { method: 'POST', body: { name: 'Sam' } }]) {
      const byKey = await api(reader.key, '/api/packs/garden/people', init)
      expect([byKey.status, byKey.json.detail]).toEqual([
        403,
        'Only the owner manages the gateway: use an owner key or /app.',
      ])
      const inside = await owner('/p/garden/api/packs/garden/people', init)
      expect([inside.status, inside.json.detail]).toEqual([
        403,
        'This request is for the pack garden only: manage the gateway at /api or in /app, without a pack.',
      ])
      const nowhere = await owner('/api/packs/nope/people', init)
      expect([nowhere.status, nowhere.json.detail]).toEqual([404, 'No pack nope. GET /api/packs lists them.'])
    }
    expect((await owner(`/api/clients/${reader.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await clientCount()).toBe(before + 1)
  })
})

describe('an answer kept for an Idempotency-Key', () => {
  const keptFor = async (id: string) => {
    const rows = await db.all<[string]>(sql`select value from kit_guards where kind = 'key' and id like ${`% ${id}`}`)
    expect(rows).toHaveLength(1)
    return JSON.parse(rows[0]?.[0] ?? '') as { status: number; headers: unknown[]; body: string }
  }
  /** Everything a stored answer says to someone reading the database. */
  const readable = (kept: { headers: unknown[]; body: string }) =>
    `${JSON.stringify(kept)}${Buffer.from(kept.body, 'base64').toString('utf8')}`

  it('holds a new key sealed, and still answers the same key to the same request', async () => {
    for (const [path, body, id] of [
      ['/api/packs/loud/people', { name: 'Sam', app: 'cursor' }, 'share-once'],
      ['/api/clients', { name: 'Sam’s script', pack: 'loud' }, 'client-once'],
    ] as const) {
      const init = { method: 'POST', body, headers: { 'idempotency-key': id } }
      const made = await owner(path, init)
      expect(made.status).toBe(201)
      const key = made.json.key as string
      expect(key).toMatch(/^gw_/)
      const kept = await keptFor(id)
      expect(kept.status).toBe(201)
      expect(readable(kept)).not.toContain('gw_')
      expect(readable(kept)).not.toContain(made.json.id)
      // The request sent again (its answer was lost on the way) is given the same key, not a second one
      const before = await clientCount()
      const again = await owner(path, init)
      expect([again.status, again.headers.get('idempotent-replayed'), again.json]).toEqual([201, 'true', made.json])
      expect(again.headers.get('location')).toBe(`/api/clients/${made.json.id}`)
      expect(await clientCount()).toBe(before)
      expect((await api(key, '/p/loud/api/me')).status).toBe(200)
      expect((await owner(`/api/clients/${made.json.id}`, { method: 'DELETE' })).status).toBe(204)
    }
  })

  it('seals at the next start what an earlier version kept as it was', async () => {
    const request = JSON.stringify({ name: 'Ola', pack: 'loud' })
    const answer = { id: 'cl_before', name: 'Ola', key: 'gw_kept-before-answers-were-sealed' }
    const plain = {
      bodyHash: createHash('sha256').update(request).digest('hex'),
      status: 201,
      headers: [['content-type', 'application/json']],
      body: Buffer.from(JSON.stringify(answer)).toString('base64'),
    }
    const id = 'key:owner POST /api/clients kept-before'
    await db.run(
      sql`insert into kit_guards (kind, id, start, used, value, expires_at) values ('key', ${id}, ${Date.now()}, 0, ${JSON.stringify(plain)}, ${Date.now() + DAY})`,
    )
    const restarted = await createApp({
      db,
      env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: MASTER_KEY },
    })
    expect(readable(await keptFor('kept-before'))).not.toContain('gw_')
    const again = await restarted.request('/api/clients', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OWNER}`,
        'content-type': 'application/json',
        'idempotency-key': 'kept-before',
      },
      body: request,
    })
    expect([again.status, again.headers.get('idempotent-replayed'), await again.json()]).toEqual([201, 'true', answer])
    await db.run(sql`delete from kit_guards where id = ${id}`)
  })
})

describe('the people a pack is shared with', () => {
  let sam: Shared
  let ola: Shared
  let lena: Shared
  const namesOf = (people: Person[]) => people.map((person) => person.name)

  beforeAll(async () => {
    await packOf('orchard', 'Orchard')
    sam = await shared('orchard', { name: 'Sam', app: 'claude-code' })
    ola = await shared('orchard', { name: 'Ola', app: 'cursor', scope: 'write' })
    lena = await shared('orchard', { name: 'Lena' })
  })

  it('lists one row per person: how they connect, what they can do, when it ends and how much they call', async () => {
    for (const text of ['one', 'two'])
      expect(
        (
          await api(sam.key, '/p/orchard/api/calls', {
            method: 'POST',
            body: { tool: 'fixture.echo', arguments: { text } },
          })
        ).status,
      ).toBe(200)
    // Ola has two of her 30 days left, Lena's ended two days ago
    await aged(ola.id, 28 * DAY, 2 * DAY)
    await aged(lena.id, 32 * DAY, -2 * DAY)
    // Not people of the pack any more: access that ended 31 days ago, and a revoked key
    const longGone = await shared('orchard', { name: 'long gone' })
    await aged(longGone.id, 61 * DAY, -31 * DAY)
    const revoked = await shared('orchard', { name: 'revoked' })
    expect((await owner(`/api/clients/${revoked.id}`, { method: 'DELETE' })).status).toBe(204)
    // One key for two packs: what is done to it is done in both
    const both = await keyFor({ name: 'Sam at work', packs: ['orchard', 'desk'], scope: 'read' })

    const listed = await peopleOf('orchard')
    // Who can use it first, oldest first; whose access ended last
    expect(namesOf(listed._embedded.people)).toEqual(['Ola', 'Sam', 'Sam at work', 'Lena'])
    expect(listed.count).toBe(4)
    expect(listed._links).toMatchObject({
      self: { href: 'http://localhost/api/packs/orchard/people' },
      pack: { href: 'http://localhost/api/packs/orchard' },
    })
    const [olaRow, samRow, bothRow, lenaRow] = listed._embedded.people
    expect(samRow).toMatchObject({
      id: sam.id,
      name: 'Sam',
      kind: 'key',
      app: 'claude-code',
      scope: 'read',
      expiresAt: sam.expiresAt,
      ending: false,
      ended: false,
      calls7d: 2,
      otherPacks: [],
      oldAddress: null,
      _links: {
        self: { href: `http://localhost/api/clients/${sam.id}` },
        calls: { href: `http://localhost/api/calls?client=${sam.id}` },
        pack: { href: 'http://localhost/api/packs/orchard' },
      },
    })
    expect(samRow?.lastCallAt).toBe((await owner(`/api/clients/${sam.id}`)).json.usage.lastCallAt)
    expect(samRow?.lastCallAt).toBeTruthy()
    expect(olaRow).toMatchObject({ id: ola.id, app: 'cursor', scope: 'write', ending: true, ended: false, calls7d: 0 })
    expect(olaRow?.lastCallAt).toBeNull()
    expect(bothRow).toMatchObject({ id: both.id, app: null, otherPacks: ['desk'], ending: false, ended: false })
    expect(lenaRow).toMatchObject({ id: lena.id, app: null, ending: false, ended: true })
    // Never the key, nor anything it could be made from
    expect(JSON.stringify(listed)).not.toContain(sam.key)
    expect(Object.keys(samRow ?? {})).not.toContain('key')

    // The pack counts the same people: its keys that work, and those that ended and can be extended
    const pack = (await owner('/api/packs/orchard')).json
    expect(pack).toMatchObject({ keys: 3, ending: 1, ended: 1 })
    expect(pack.keys + pack.ended).toBe(listed.count)
    expect(pack._links.people.href).toBe('http://localhost/api/packs/orchard/people')
    // In the other pack the same key is a person too, with this one beside it
    expect((await peopleOf('desk'))._embedded.people.find((person) => person.id === both.id)?.otherPacks).toEqual([
      'orchard',
    ])
    expect((await owner(`/api/clients/${both.id}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('shows someone just extended as neither ending nor ended', async () => {
    for (const id of [ola.id, lena.id]) expect((await extend(id, '7d')).status).toBe(200)
    const listed = await peopleOf('orchard')
    expect(namesOf(listed._embedded.people)).toEqual(['Lena', 'Ola', 'Sam'])
    for (const person of listed._embedded.people)
      expect([person.name, person.ending, person.ended]).toEqual([person.name, false, false])
    expect((await owner('/api/packs/orchard')).json).toMatchObject({ keys: 3, ending: 0, ended: 0 })
    // The same key as before
    expect((await api(lena.key, '/p/orchard/api/me')).status).toBe(200)
  })

  it('notes who still connects at an address the pack used to have', async () => {
    expect((await owner('/api/packs/orchard', { method: 'PATCH', body: { name: 'grove' } })).status).toBe(200)
    expect((await api(sam.key, '/p/orchard/api/me')).json.pack.name).toBe('grove')
    expect((await api(ola.key, '/p/grove/api/me')).status).toBe(200)
    const byName = async () =>
      Object.fromEntries((await peopleOf('grove'))._embedded.people.map((person) => [person.name, person.oldAddress]))
    const noted = await byName()
    expect(noted).toEqual({ Sam: { name: 'orchard', lastAt: expect.any(String) }, Ola: null, Lena: null })
    expect(Date.parse(noted.Sam?.lastAt ?? '')).toBeGreaterThan(Date.now() - 60_000)
    expect((await owner('/api/packs/grove')).json.formerNames).toEqual([
      { name: 'orchard', until: expect.any(String), people: 1 },
    ])
    const gone = await owner('/api/packs/orchard/people')
    expect([gone.status, gone.json.detail]).toEqual([
      404,
      'No pack orchard: it was renamed to grove. GET /api/packs/grove.',
    ])
    // Someone whose access ended is still listed, to be extended, so the old address still counts them: the owner
    // who frees it would cut off the setup an Extend brings back
    await end(sam.id)
    const ended = (await peopleOf('grove'))._embedded.people.find((person) => person.id === sam.id)
    expect(ended).toMatchObject({ ended: true, oldAddress: { name: 'orchard' } })
    expect((await owner('/api/packs/grove')).json).toMatchObject({
      keys: 2,
      ended: 1,
      formerNames: [{ name: 'orchard', people: 1 }],
    })
    expect((await extend(sam.id, '30d')).status).toBe(200)
    expect((await api(sam.key, '/p/orchard/api/me')).json.pack.name).toBe('grove')
    // Set up with the new address, the note goes
    expect((await api(sam.key, '/p/grove/api/me')).status).toBe(200)
    expect((await byName()).Sam).toBeNull()
  })

  it('is empty once everyone is revoked', async () => {
    for (const person of [sam, ola, lena])
      expect((await owner(`/api/clients/${person.id}`, { method: 'DELETE' })).status).toBe(204)
    const listed = await peopleOf('grove')
    expect([listed.count, listed._embedded.people]).toEqual([0, []])
    expect((await owner('/api/packs/grove')).json).toMatchObject({ keys: 0, ending: 0, ended: 0 })
  })

  it('still lists them after more revoked keys than one statement can name', async () => {
    const revokedAt = new Date().toISOString()
    // Past SQLite's 32,766 values in one statement
    await db.run(sql`
      with recursive n(i) as (select 1 union all select i + 1 from n where i < 33000)
      insert into clients (id, name, kind, scope, all_upstreams, own_pins, mac_tools, result_cap, pack_id, created_at, revoked_at)
      select 'cl_revoked_' || i, 'revoked ' || i, 'key', 'read', 0, 0, 0, 1000, (select id from packs where name = 'grove'), ${revokedAt}, ${revokedAt} from n`)
    await db.run(
      sql`insert into client_packs (client_id, pack_id, position) select id, pack_id, 0 from clients where id like 'cl_revoked_%'`,
    )
    const lena = await shared('grove', { name: 'Lena' })
    expect((await peopleOf('grove'))._embedded.people.map((person) => person.id)).toEqual([lena.id])
    expect((await owner('/api/packs/grove')).json).toMatchObject({ keys: 1, ending: 0, ended: 0 })
    expect((await owner('/api/packs')).status).toBe(200)
    await db.run(sql`delete from client_packs where client_id like 'cl_revoked_%'`)
    await db.run(sql`delete from clients where id like 'cl_revoked_%'`)
    expect((await owner(`/api/clients/${lena.id}`, { method: 'DELETE' })).status).toBe(204)
  })
})
