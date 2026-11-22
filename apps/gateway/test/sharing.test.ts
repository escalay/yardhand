/**
 * Sharing a pack with key-based apps: how long a key works, moving its end, and what its holder and the owner are
 * told once it has ended.
 */
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { dayOf } from '../src/features/clients/lifetimes.js'
import { PACK_PATHS } from '../src/features/packs/docs.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-sharing'
const upstream = await startUpstream({ token: 'fixture-token' })
const db = await testDb()
const app = await createApp({
  db,
  env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
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
  return { status: response.status, json: (await response.json().catch(() => null)) as any }
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
    expect(made.json.counts).toEqual({ tools: 2, playbooks: 1, manuals: 1, ownPlaybooks: 0 })
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

  it('is refused for a key whose only pack was removed, and takes a pack given with it', async () => {
    const made = await owner('/api/packs', {
      method: 'POST',
      body: { name: 'barn', title: 'Barn', description: 'Soon removed.' },
    })
    expect(made.status).toBe(201)
    const sam = await keyFor({ name: 'Sam', pack: 'barn', expiresIn: '8h' })
    const day = await end(sam.id)
    expect((await owner('/api/packs/barn', { method: 'DELETE' })).status).toBe(204)
    // Extending it would open nothing: the owner is told what to do, and the key stays ended
    const before = (await owner(`/api/clients/${sam.id}`)).json.expiresAt
    const refused = await extend(sam.id, '7d')
    expect([refused.status, refused.json.detail]).toEqual([
      409,
      `Sam’s pack was removed, so extending the key would open nothing: make a new key, or give this one a pack with PATCH /api/clients/${sam.id} {"packs":["<name>"],"expiresIn":"7d"}.`,
    ])
    expect((await owner(`/api/clients/${sam.id}`)).json.expiresAt).toBe(before)
    expect(day).toBeTruthy()
    expect((await api(sam.key, '/api/me')).status).toBe(403)
    // The same change gives it a pack that is there
    const moved = await owner(`/api/clients/${sam.id}`, { method: 'PATCH', body: { packs: ['loud'], expiresIn: '7d' } })
    expect([moved.status, fromNow(moved.json.expiresAt)]).toEqual([200, 7 * DAY])
    expect((await api(sam.key, '/p/loud/api/me')).status).toBe(200)
  })

  it('brings a key whose default pack was removed back to nothing there, whatever its own allowlist says', async () => {
    const made = await owner('/api/packs', {
      method: 'POST',
      body: { name: 'shed', title: 'Shed', description: 'Soon removed.', playbook: 'fixture-say-it-back' },
    })
    expect(made.status).toBe(201)
    // It opens two packs, so it can still be extended once its default is gone
    const sam = await keyFor({ name: 'Sam', packs: ['shed', 'loud'], pack: 'shed', expiresIn: '8h' })
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
