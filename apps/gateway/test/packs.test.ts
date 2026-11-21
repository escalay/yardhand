/**
 * Packs: a curated kit a key can be locked to. Starting from a playbook brings in the tools it names or calls by route;
 * a pack key sees and runs only the pack, in the pack's wording; wording the upstream has since rewritten is flagged.
 */
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-packs'
const upstream = await startUpstream({ token: 'fixture-token', greeting: true })
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

type Init = { method?: string; body?: unknown }
const api = async (key: string, path: string, init: Init = {}) => {
  const response = await app.request(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  return { status: response.status, json: (await response.json().catch(() => null)) as any }
}
const owner = (path: string, init?: Init) => api(OWNER, path, init)
/** An answer with its headers and text, with a key or (null) without credentials. */
const at = async (key: string | null, path: string, init: Init & { headers?: Record<string, string> } = {}) => {
  const response = await app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      'content-type': 'application/json',
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await response.text()
  const json = (() => {
    try {
      return JSON.parse(text) as any
    } catch {
      return null
    }
  })()
  return { status: response.status, headers: response.headers, text, json }
}
const namesOf = (items: { name: string }[]) => items.map((item) => item.name)
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
const mcp = async (key: string, path = '/mcp', headers: Record<string, string> = {}) => {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(path, origin), {
      requestInit: { headers: { authorization: `Bearer ${key}`, ...headers } },
    }),
  )
  return client
}
const keyFor = async (body: Record<string, unknown>) => {
  const made = await owner('/api/clients', { method: 'POST', body: { scope: 'write', ...body } })
  expect(made.status).toBe(201)
  return made.json as { id: string; key: string; pack: string | null; expiresAt: string | null }
}

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
})

describe('what a playbook uses', () => {
  it('finds the tools it names', async () => {
    const { json } = await owner('/api/playbooks/fixture-say-it-back/uses')
    expect(json).toMatchObject({ upstream: 'fixture', textRead: true, manual: 'fixture' })
    expect(json.uses).toEqual([
      expect.objectContaining({ tool: 'fixture.echo', reason: 'named', inPack: false }),
      expect.objectContaining({ tool: 'fixture.shout', reason: 'named' }),
    ])
  })

  it('finds a tool by the route it calls, from the route the server publishes', async () => {
    expect((await owner('/api/tools/fixture.echo')).status).toBe(200)
    const { json } = await owner('/api/playbooks/fixture-warm-up/uses')
    expect(json.uses).toEqual([expect.objectContaining({ tool: 'fixture.echo', reason: 'route' })])
  })
})

describe('a pack', () => {
  it('starts from a playbook: it, the tools it uses and its server’s manual go in', async () => {
    const made = await owner('/api/packs', {
      method: 'POST',
      body: { name: 'loud', title: 'Loud', description: 'Say things back, loudly.', playbook: 'fixture-say-it-back' },
    })
    expect(made.status).toBe(201)
    expect(made.json).toMatchObject({
      name: 'loud',
      counts: { tools: 2, playbooks: 1, manuals: 1 },
      upstreams: ['fixture'],
      playbooks: [expect.objectContaining({ name: 'fixture-say-it-back', title: 'Fixture · Say it back' })],
      manuals: [expect.objectContaining({ name: 'fixture' })],
    })
    expect(made.json.tools).toEqual([
      expect.objectContaining({ name: 'fixture.echo', reason: 'named', via: 'fixture-say-it-back', wording: null }),
      expect.objectContaining({ name: 'fixture.shout', reason: 'named', via: 'fixture-say-it-back' }),
    ])
    expect((await owner('/api/packs')).json._embedded.packs).toEqual([
      expect.objectContaining({ name: 'loud', keys: 0, flags: 0 }),
    ])
  })

  it('refuses a name already taken and tools that are not live', async () => {
    expect((await owner('/api/packs', { method: 'POST', body: { name: 'loud', title: 'Again' } })).status).toBe(409)
    const bad = await owner('/api/packs/loud', {
      method: 'PATCH',
      body: { add: { tools: [{ name: 'fixture.nope' }] } },
    })
    expect(bad.status).toBe(400)
    expect(bad.json.detail).toContain('fixture.nope')
  })
})

describe('a key locked to a pack', () => {
  let quiet = ''
  let quietId = ''
  beforeAll(async () => {
    await owner('/api/packs', { method: 'POST', body: { name: 'quiet', title: 'Quiet', description: 'Only echo.' } })
    await owner('/api/packs/quiet', {
      method: 'PATCH',
      body: { add: { tools: [{ name: 'fixture.echo' }], playbooks: ['fixture-warm-up'] } },
    })
    const made = await keyFor({ name: 'quiet-agent', pack: 'quiet', expiresIn: '8h' })
    expect(made.pack).toBe('quiet')
    expect(Date.parse(made.expiresAt ?? '') - Date.now()).toBeGreaterThan(7.9 * 3_600_000)
    quiet = made.key
    quietId = made.id
  })

  it('sees only the pack, its tools listed directly', async () => {
    const me = (await api(quiet, '/api/me')).json
    expect(me.pins.map((pin: { name: string }) => pin.name)).toEqual(['fixture.echo'])
    expect(me.pack).toMatchObject({ name: 'quiet', playbooks: ['fixture-warm-up'], manuals: [] })
    expect((await api(quiet, '/api/tools?q=shout')).json._embedded.tools).toEqual([])
    expect((await api(quiet, '/api/tools/fixture.shout')).status).toBe(404)
    expect((await api(quiet, '/api/playbooks')).json._embedded.playbooks.map((p: { name: string }) => p.name)).toEqual([
      'fixture-warm-up',
    ])
    expect((await api(quiet, '/api/manuals')).json._embedded.manuals).toEqual([])
  })

  it('opens only the links its tools returned, not the rest of the upstream', async () => {
    const asQuiet = { headers: { authorization: `Bearer ${quiet}` } }
    const note = `/api/resources?uri=${encodeURIComponent('fixture://notes/7')}`
    const closed = await app.request('/u/fixture/r/files/a.txt', asQuiet)
    expect(closed.status).toBe(403)
    expect(((await closed.json()) as { detail: string }).detail).toMatch(/only the links its tools returned/)
    expect((await api(quiet, note)).status).toBe(403)
    const file = `${new URL(upstream.url).origin}/files/a.txt`
    const ran = await api(quiet, '/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.echo', arguments: { text: `See [the file](${file}) and fixture://notes/7.` } },
    })
    expect(ran.json.result.content[0].text).toContain('/u/fixture/r/files/a.txt')
    expect(await (await app.request('/u/fixture/r/files/a.txt', asQuiet)).text()).toBe('file body')
    expect((await api(quiet, note)).json.contents[0].text).toBe('Note 7')
    expect((await app.request('/u/fixture/r/files/record.json', asQuiet)).status).toBe(403)
    // The owner, and a key outside packs, open the host as before
    expect(
      (await app.request('/u/fixture/r/files/a.txt', { headers: { authorization: `Bearer ${OWNER}` } })).status,
    ).toBe(200)
  })

  it('is refused a tool outside the pack, and the refusal is logged', async () => {
    const refused = await api(quiet, '/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.shout', arguments: { text: 'hi' } },
    })
    expect(refused.status).toBe(403)
    expect(refused.json.detail).toContain('Quiet')
    const log = (await owner(`/api/calls?client=${quietId}`)).json._embedded.calls
    expect(log[0]).toMatchObject({ tool: 'fixture.shout', status: 'refused' })
    const ran = await api(quiet, '/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.echo', arguments: { text: 'hi' } },
    })
    expect(ran.status).toBe(200)
  })

  it('gets no passthrough: that would serve the whole server', async () => {
    const response = await app.request('/u/fixture/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${quiet}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(response.status).toBe(403)
  })

  it('over MCP: the pack’s tools in its wording, and the pack as the instructions', async () => {
    const worded = await owner('/api/packs/quiet/tools/fixture.echo/wording', {
      method: 'PUT',
      body: { description: 'Says your words back. Use it to check the line.' },
    })
    expect(worded.json).toMatchObject({ wording: 'Says your words back. Use it to check the line.', flag: null })
    expect((await api(quiet, '/api/tools/fixture.echo')).json.description).toBe(
      'Says your words back. Use it to check the line.',
    )
    expect((await owner('/api/tools/fixture.echo')).json.description).toBe('Echoes the text back.')
    const client = await mcp(quiet)
    const listed = (await client.listTools()).tools
    expect(listed.find((tool) => tool.name === 'fixture.echo')?.description).toBe(
      'Says your words back. Use it to check the line.',
    )
    expect(listed.find((tool) => tool.name === 'fixture.shout')).toBeUndefined()
    expect(namesOf(listed).sort()).toEqual([...META, 'fixture.echo'].sort())
    expect(client.getServerVersion()).toMatchObject({ name: 'quiet', title: 'Quiet', description: 'Only echo.' })
    expect(client.getInstructions()).toMatch(/^Quiet: Only echo\./)
    // Its one connection, counted as the pack holds it: one tool, and no manual
    expect(client.getInstructions()).toMatch(/^- fixture: Fixture \(1 tool, 1 playbook\)$/m)
    expect(await said(client, 'describe_tool', { name: 'fixture.echo' })).toContain(
      'Says your words back. Use it to check the line.',
    )
    const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name)
    expect(prompts).toContain('fixture-warm-up')
    expect(prompts).not.toContain('fixture-say-it-back')
    await client.close()
  })

  it('flags wording the upstream has since rewritten, until the owner keeps it', async () => {
    upstream.state.echoDescription = 'Echoes the text back, now with timing.'
    await owner('/api/upstreams/fixture/sync', { method: 'POST' })
    const pending = (await owner('/api/reviews')).json._embedded.reviews.find(
      (review: { name: string }) => review.name === 'fixture.echo',
    )
    await owner(`/api/reviews/${pending.versionId}`, { method: 'POST', body: { decision: 'approve' } })

    const pack = (await owner('/api/packs/quiet')).json
    expect(pack.flags).toBe(1)
    expect(pack.tools[0].flag).toEqual({
      was: 'Echoes the text back.',
      now: 'Echoes the text back, now with timing.',
    })
    expect((await owner('/api/packs/flags')).json._embedded.flags).toEqual([
      expect.objectContaining({ pack: 'quiet', tool: 'fixture.echo', now: 'Echoes the text back, now with timing.' }),
    ])
    // Agents keep the pack's text meanwhile
    expect((await api(quiet, '/api/tools/fixture.echo')).json.description).toContain('check the line')

    await owner('/api/packs/quiet/tools/fixture.echo/wording', {
      method: 'PUT',
      body: { description: pack.tools[0].wording },
    })
    expect((await owner('/api/packs/quiet')).json.flags).toBe(0)
  })

  it('cannot remove a pack while a key is locked to it', async () => {
    const refused = await owner('/api/packs/quiet', { method: 'DELETE' })
    expect(refused.status).toBe(409)
    expect(refused.json.detail).toContain('quiet-agent')
  })

  it('has its own guide: the pack’s tools in its wording, and nothing of the gateway’s', async () => {
    const guide = await at(quiet, '/p/quiet/llms.txt')
    expect(guide.status).toBe(200)
    expect(guide.headers.get('content-type')).toContain('text/markdown')
    expect(guide.headers.get('cache-control')).toBe('private, no-cache')
    expect(guide.text).toMatch(/^# Quiet\n\nOnly echo\./)
    expect(guide.text).toContain('- `fixture.echo`: Says your words back. Use it to check the line.')
    expect(guide.text).toContain('- `fixture-warm-up`')
    expect(guide.text).toContain('http://localhost/p/quiet/mcp')
    expect(guide.text).toContain('http://localhost/p/quiet/api')
    expect(guide.text).not.toContain('fixture.shout')
    expect(guide.text).not.toContain('/api/clients')
    expect(guide.text).not.toContain('## Manuals')
    // The owner reads it too, at the pack's address
    expect((await at(OWNER, '/p/quiet/llms.txt')).text).toMatch(/^# Quiet/)
  })

  it('has its own OpenAPI document and docs page', async () => {
    const doc = await at(quiet, '/p/quiet/openapi.json')
    expect(doc.status).toBe(200)
    expect(doc.headers.get('cache-control')).toBe('private, no-cache')
    expect(doc.json.info).toMatchObject({ title: 'Quiet' })
    expect(doc.json.info.description).toContain('Only echo.')
    expect(doc.json.servers[0].url).toBe('http://localhost/p/quiet')
    expect(doc.json.paths['/api/tools/fixture.echo/calls'].post.description).toBe(
      'Says your words back. Use it to check the line.',
    )
    const paths = Object.keys(doc.json.paths)
    expect(paths).toEqual(expect.arrayContaining(['/api', '/api/tools', '/api/calls', '/api/playbooks']))
    expect(paths.filter((path) => /clients|packs|pins|system|shout/.test(path))).toEqual([])
    const docs = await at(quiet, '/p/quiet/docs')
    expect(docs.status).toBe(200)
    expect(docs.headers.get('content-type')).toContain('text/html')
    expect(docs.headers.get('cache-control')).toBe('private, no-cache')
    expect(docs.text).toContain('/p/quiet/openapi.json')
    expect(docs.text).toContain('Quiet — API')
    for (const path of ['/p/quiet', '/p/quiet/']) {
      const front = await at(quiet, path)
      expect([front.status, front.headers.get('location')]).toEqual([302, '/p/quiet/docs'])
    }
  })

  it('keeps a pack’s pages to those who open it', async () => {
    const outside = await keyFor({ name: 'not-in-packs', upstreams: 'all' })
    for (const path of ['/p/Quiet/docs', `/p/${'q'.repeat(41)}/docs`, '/p/quiet/docs/more'])
      for (const key of [quiet, outside.key, OWNER]) expect([path, (await at(key, path)).status]).toEqual([path, 404])
    // A key that doesn't open the pack is told which it does; a pack that isn't there, that it isn't
    for (const path of ['/p/loud', '/p/loud/docs', '/p/loud/llms.txt', '/p/loud/openapi.json']) {
      const refused = await at(quiet, path)
      expect([path, refused.status]).toEqual([path, 403])
      expect(refused.json.detail).toContain("doesn't open the pack loud")
    }
    expect((await at(outside.key, '/p/quiet/llms.txt')).status).toBe(403)
    expect((await at(OWNER, '/p/nope/docs')).json.detail).toBe('No pack nope. GET /api/packs lists them.')
    // The gateway's own guide and docs stay where they were
    expect((await at(quiet, '/llms.txt')).text).not.toMatch(/^# Quiet/)
    await owner(`/api/clients/${outside.id}`, { method: 'DELETE' })
  })

  it('stops working when it expires, and says so', async () => {
    await db.run(
      sql`update clients set expires_at = ${new Date(Date.now() - 1000).toISOString()} where id = ${quietId}`,
    )
    const refused = await api(quiet, '/api/me')
    expect(refused.status).toBe(403)
    expect(refused.json.detail).toContain('expired')
    expect((await owner('/api/packs/quiet')).json.keys).toBe(0)
    expect((await owner('/api/packs/quiet', { method: 'DELETE' })).status).toBe(204)
  })
})

describe('a read-only pack key', () => {
  it('does not list the pack’s tools that change things', async () => {
    const { key } = await keyFor({ name: 'loud-reader', pack: 'loud', scope: 'read' })
    expect((await api(key, '/api/me')).json.pins.map((pin: { name: string }) => pin.name)).toEqual(['fixture.echo'])
  })
})

describe('a key without a pack', () => {
  it('still needs upstreams', async () => {
    expect((await owner('/api/clients', { method: 'POST', body: { name: 'nothing' } })).status).toBe(400)
  })
})

describe('a pack’s own names and fixed inputs', () => {
  let desk = ''
  beforeAll(async () => {
    await owner('/api/packs', {
      method: 'POST',
      body: { name: 'desk', title: 'Front desk', description: 'Greets for the desk.' },
    })
    const added = await owner('/api/packs/desk', {
      method: 'PATCH',
      body: {
        add: {
          tools: [
            { name: 'fixture.greet', alias: 'greet_from_desk', fixed: { from: 'the desk' } },
            { name: 'fixture.greet', alias: 'greet_from_boss', fixed: { from: 'the boss' } },
            { name: 'fixture.echo' },
          ],
        },
      },
    })
    expect(added.status).toBe(200)
    desk = (await keyFor({ name: 'desk-agent', pack: 'desk' })).key
  })

  it('holds one tool twice, under two names, each fixing its own input', async () => {
    const pack = (await owner('/api/packs/desk')).json
    expect(pack.tools.map((tool: { name: string; tool: string; alias: string | null; fixed: object }) => tool)).toEqual(
      [
        expect.objectContaining({
          name: 'greet_from_desk',
          tool: 'fixture.greet',
          alias: 'greet_from_desk',
          fixed: { from: 'the desk' },
          lostInputs: [],
        }),
        expect.objectContaining({ name: 'greet_from_boss', tool: 'fixture.greet', fixed: { from: 'the boss' } }),
        expect.objectContaining({ name: 'fixture.echo', tool: 'fixture.echo', alias: null, fixed: {} }),
      ],
    )
    expect(pack.counts.tools).toBe(3)
  })

  it('shows its keys the pack’s names, without the fixed inputs', async () => {
    const me = (await api(desk, '/api/me')).json
    expect(me.pins.map((pin: { name: string }) => pin.name)).toEqual([
      'greet_from_desk',
      'greet_from_boss',
      'fixture.echo',
    ])
    const greet = me.pins[0]
    expect(Object.keys(greet.inputSchema.properties)).toEqual(['to'])
    expect(greet.inputSchema.required).toEqual(['to'])
    const detail = (await api(desk, '/api/tools/greet_from_boss')).json
    expect(detail).toMatchObject({ name: 'greet_from_boss', upstream: 'fixture' })
    expect(Object.keys(detail.inputSchema.properties)).toEqual(['to'])
    expect((await api(desk, '/api/tools/fixture.greet')).status).toBe(404)
    const found = (await api(desk, '/api/tools?q=greets')).json._embedded.tools.map(
      (tool: { name: string }) => tool.name,
    )
    expect(found).toEqual(['greet_from_desk', 'greet_from_boss'])
  })

  it('fills the fixed inputs on every call, and refuses a call that sends one', async () => {
    const ran = await api(desk, '/api/calls', {
      method: 'POST',
      body: { tool: 'greet_from_boss', arguments: { to: 'Ana' } },
    })
    expect(ran.status).toBe(200)
    expect(ran.json.result.content[0].text).toBe('Hello Ana, from the boss')
    const named = await api(desk, '/api/tools/greet_from_desk/calls', { method: 'POST', body: { to: 'Ben' } })
    expect(named.json.result.content[0].text).toBe('Hello Ben, from the desk')
    const forged = await api(desk, '/api/calls', {
      method: 'POST',
      body: { tool: 'greet_from_desk', arguments: { to: 'Ana', from: 'someone else' } },
    })
    expect(forged.status).toBe(400)
    expect(forged.json.detail).toContain('fills from itself')
    expect(
      (
        await api(desk, '/api/calls', {
          method: 'POST',
          body: { tool: 'fixture.greet', arguments: { to: 'Ana', from: 'me' } },
        })
      ).status,
    ).toBe(403)
    // The log keeps the tool’s own name, so the owner’s numbers add up per tool
    const log = (await owner('/api/calls?tool=fixture.greet')).json._embedded.calls
    expect(log.map((call: { status: string }) => call.status).sort()).toEqual(['ok', 'ok', 'refused', 'refused'])
  })

  it('over MCP: the pack’s names, called as they are', async () => {
    const client = await mcp(desk)
    const listed = (await client.listTools()).tools
    const greet = listed.find((tool) => tool.name === 'greet_from_desk')
    expect(Object.keys((greet?.inputSchema.properties ?? {}) as object)).toEqual(['to'])
    expect(listed.find((tool) => tool.name === 'fixture.greet')).toBeUndefined()
    expect(client.getInstructions()).toContain('- greet_from_boss:')
    const answer = await client.callTool({ name: 'greet_from_desk', arguments: { to: 'Cy' } })
    expect((answer.content as { text: string }[])[0]?.text).toBe('Hello Cy, from the desk')
    await client.close()
  })

  it('renames a tool and changes what it fixes, checked against the live tool', async () => {
    const renamed = await owner('/api/packs/desk/tools/greet_from_boss', {
      method: 'PATCH',
      body: { alias: 'greet_from_ceo', fixed: { from: 'the CEO' } },
    })
    expect(renamed.status).toBe(200)
    expect(renamed.json).toMatchObject({ name: 'greet_from_ceo', fixed: { from: 'the CEO' } })
    const taken = await owner('/api/packs/desk/tools/greet_from_ceo', {
      method: 'PATCH',
      body: { alias: 'greet_from_desk' },
    })
    expect(taken.status).toBe(409)
    const unknown = await owner('/api/packs/desk/tools/greet_from_ceo', {
      method: 'PATCH',
      body: { fixed: { colour: 'red' } },
    })
    expect(unknown.status).toBe(400)
    expect(unknown.json.detail).toContain('has no input colour')
    const wrongType = await owner('/api/packs/desk/tools/greet_from_ceo', {
      method: 'PATCH',
      body: { fixed: { from: 7 } },
    })
    expect(wrongType.status).toBe(400)
    const badAdd = await owner('/api/packs/desk', {
      method: 'PATCH',
      body: { add: { tools: [{ name: 'fixture.greet', alias: 'greet_bad', fixed: { colour: 'red' } }] } },
    })
    expect(badAdd.status).toBe(400)
    const worded = await owner('/api/packs/desk/tools/greet_from_ceo/wording', {
      method: 'PUT',
      body: { description: 'Greets on behalf of the CEO.' },
    })
    expect(worded.json).toMatchObject({ name: 'greet_from_ceo', wording: 'Greets on behalf of the CEO.' })
    expect((await api(desk, '/api/tools/greet_from_ceo')).json.description).toBe('Greets on behalf of the CEO.')
    const back = await owner('/api/packs/desk/tools/greet_from_ceo', {
      method: 'PATCH',
      body: { alias: null, fixed: null },
    })
    expect(back.json).toMatchObject({ name: 'fixture.greet', alias: null, fixed: {} })
  })

  it('flags a fixed input the upstream no longer takes', async () => {
    upstream.state.greetFrom = false
    await owner('/api/upstreams/fixture/sync', { method: 'POST' })
    const pending = (await owner('/api/reviews')).json._embedded.reviews.find(
      (review: { name: string }) => review.name === 'fixture.greet',
    )
    await owner(`/api/reviews/${pending.versionId}`, { method: 'POST', body: { decision: 'approve' } })
    const pack = (await owner('/api/packs/desk')).json
    expect(pack.tools[0]).toMatchObject({ name: 'greet_from_desk', lostInputs: ['from'] })
    expect(pack.flags).toBe(1)
    expect((await owner('/api/packs/flags')).json._embedded.flags).toContainEqual(
      expect.objectContaining({ kind: 'input', pack: 'desk', tool: 'greet_from_desk', was: 'fixes from' }),
    )
    const fixedAgain = await owner('/api/packs/desk/tools/greet_from_desk', {
      method: 'PATCH',
      body: { fixed: { sender: 'the desk' } },
    })
    expect(fixedAgain.json.lostInputs).toEqual([])
    const ran = await api(desk, '/api/calls', {
      method: 'POST',
      body: { tool: 'greet_from_desk', arguments: { to: 'Di' } },
    })
    expect(ran.json.result.content[0].text).toBe('Hello Di, from the desk')
    // Back as it was, for the config below
    upstream.state.greetFrom = true
    await owner('/api/upstreams/fixture/sync', { method: 'POST' })
    const back = (await owner('/api/reviews')).json._embedded.reviews.find(
      (review: { name: string }) => review.name === 'fixture.greet',
    )
    await owner(`/api/reviews/${back.versionId}`, { method: 'POST', body: { decision: 'approve' } })
    await owner('/api/packs/desk/tools/greet_from_desk', { method: 'PATCH', body: { fixed: { from: 'the desk' } } })
  })
})

describe('a key with several packs', () => {
  let both = ''
  let bothId = ''
  beforeAll(async () => {
    const made = await keyFor({ name: 'two-packs', packs: ['desk', 'loud'], pack: 'desk' })
    expect(made).toMatchObject({ pack: 'desk', packs: ['desk', 'loud'] })
    both = made.key
    bothId = made.id
  })
  const asPack = async (pack: string, path: string) => {
    const response = await app.request(path, { headers: { authorization: `Bearer ${both}`, 'x-gateway-pack': pack } })
    return { status: response.status, json: (await response.json()) as any }
  }

  it('serves its default pack at plain /mcp and REST, and lists every pack it opens', async () => {
    const me = (await api(both, '/api/me')).json
    expect(me.pack.name).toBe('desk')
    expect(me.packs).toEqual([
      { name: 'desk', title: 'Front desk', mcpUrl: 'http://localhost/p/desk/mcp', default: true },
      { name: 'loud', title: 'Loud', mcpUrl: 'http://localhost/p/loud/mcp', default: false },
    ])
    expect(me.pins.map((pin: { name: string }) => pin.name)).toContain('greet_from_desk')
  })

  it('serves another of its packs when REST names it, and refuses a pack it doesn’t open', async () => {
    const loud = await asPack('loud', '/api/me')
    expect(loud.json.pack.name).toBe('loud')
    expect(loud.json.pins.map((pin: { name: string }) => pin.name)).toEqual(['fixture.echo', 'fixture.shout'])
    const other = await asPack('quiet', '/api/me')
    expect(other.status).toBe(403)
    expect(other.json.detail).toBe(
      "This key doesn't open the pack quiet. It opens desk (/p/desk/mcp), loud (/p/loud/mcp).",
    )
  })

  it('over MCP: one connection per pack at /mcp/p/<pack>, each naming the others', async () => {
    const loud = await mcp(both, '/mcp/p/loud')
    expect((await loud.listTools()).tools.map((tool) => tool.name)).toContain('fixture.shout')
    expect(loud.getInstructions()).toMatch(/^Loud: Say things back, loudly\./)
    expect(loud.getInstructions()).toContain('Front desk (http://')
    const shouted = await loud.callTool({ name: 'fixture.shout', arguments: { text: 'hey' } })
    expect((shouted.content as { text: string }[])[0]?.text).toBe('HEY')
    await loud.close()
    const desk = await mcp(both, '/mcp')
    const names = (await desk.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('greet_from_desk')
    expect(names).not.toContain('fixture.shout')
    await desk.close()
    const refused = await app.request('/mcp/p/quiet', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${both}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    })
    const listed = await app.request('/mcp/p/quiet', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${both}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as { detail: string }).detail).toContain("doesn't open the pack quiet")
    expect(listed.status).toBe(403)
  })

  it('hands out one server per pack in its setup', async () => {
    const setup = (await owner(`/api/clients/${bothId}/setup`)).json
    const claude = setup.surfaces.find((surface: { id: string }) => surface.id === 'claude-code')
    expect(claude.snippet).toContain('gw-desk http://localhost/p/desk/mcp')
    expect(claude.snippet).toContain('gw-loud http://localhost/p/loud/mcp')
  })

  it('changes which packs it opens and its default, and only a pack key takes packs', async () => {
    const changed = await owner(`/api/clients/${bothId}`, { method: 'PATCH', body: { packs: ['loud'] } })
    expect(changed.json).toMatchObject({ pack: 'loud', packs: ['loud'] })
    expect((await api(both, '/api/me')).json.pack.name).toBe('loud')
    const back = await owner(`/api/clients/${bothId}`, {
      method: 'PATCH',
      body: { packs: ['loud', 'desk'], pack: 'desk' },
    })
    expect(back.json).toMatchObject({ pack: 'desk', packs: ['desk', 'loud'] })
    const notOne = await owner(`/api/clients/${bothId}`, { method: 'PATCH', body: { pack: 'quiet' } })
    expect(notOne.status).toBe(400)
    const plain = await keyFor({ name: 'plain', upstreams: 'all' })
    const refused = await owner(`/api/clients/${plain.id}`, { method: 'PATCH', body: { packs: ['desk'] } })
    expect(refused.status).toBe(409)
    expect((await api(OWNER, '/api/me', {})).status).toBe(200)
    // The owner asking for a pack is answered as a write key of that pack would be
    const ownerAsked = await at(OWNER, '/api/me', { headers: { 'x-gateway-pack': 'desk' } })
    expect(ownerAsked.status).toBe(200)
    expect(ownerAsked.json).toMatchObject({ owner: false, scope: 'write', pack: { name: 'desk' } })
  })

  it('counts as a key of every pack it opens', async () => {
    expect((await owner('/api/packs/loud')).json.keyList.map((key: { name: string }) => key.name)).toContain(
      'two-packs',
    )
    expect((await owner('/api/packs/desk', { method: 'DELETE' })).status).toBe(409)
  })
})

describe('a pack at its own address', () => {
  let key = ''
  beforeAll(async () => {
    key = (await keyFor({ name: 'at-address', packs: ['desk', 'loud'], pack: 'desk' })).key
  })

  it('serves REST and MCP under /p/<pack>/, beside the old address and the header', async () => {
    expect((await api(key, '/p/loud/api/me')).json.pack.name).toBe('loud')
    expect(namesOf((await api(key, '/p/loud/api/tools')).json._embedded.tools)).toEqual([
      'fixture.echo',
      'fixture.shout',
    ])
    const ran = await api(key, '/p/loud/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.shout', arguments: { text: 'hey' } },
    })
    expect(ran.json.result.content[0].text).toBe('HEY')
    const named = await api(key, '/p/loud/api/tools/fixture.shout/calls', { method: 'POST', body: { text: 'ho' } })
    expect(named.json.result.content[0].text).toBe('HO')
    // A tool of its other pack is not here
    const other = await api(key, '/p/loud/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.greet', arguments: { to: 'Al', from: 'me' } },
    })
    expect(other.status).toBe(403)
    expect(other.json.detail).toContain('is not in Loud')
    const client = await mcp(key, '/p/loud/mcp')
    const listed = namesOf((await client.listTools()).tools)
    expect(listed).toContain('fixture.shout')
    expect(listed).not.toContain('greet_from_desk')
    const shouted = await client.callTool({ name: 'fixture.shout', arguments: { text: 'mcp' } })
    expect((shouted.content as { text: string }[])[0]?.text).toBe('MCP')
    await client.close()
    // The old address and the header answer as before
    const legacy = await mcp(key, '/mcp/p/loud')
    expect(namesOf((await legacy.listTools()).tools)).toContain('fixture.shout')
    await legacy.close()
    expect((await at(key, '/api/me', { headers: { 'x-gateway-pack': 'loud' } })).json.pack.name).toBe('loud')
    expect((await api(key, '/api/me')).json.pack.name).toBe('desk')
  })

  it('asks for credentials at every path, for a pack that exists and one that does not alike', async () => {
    for (const path of ['', '/', '/api', '/api/health', '/api/session', '/docs', '/llms.txt', '/openapi.json']) {
      const real = await at(null, `/p/loud${path}`)
      const none = await at(null, `/p/nope${path}`)
      expect([path, real.status, real.json?.detail]).toEqual([path, 401, none.json?.detail])
      expect(none.status).toBe(401)
      expect(real.headers.get('link')).toBeNull()
    }
    const real = await at(null, '/p/loud/mcp', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    const none = await at(null, '/p/nope/mcp', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect([real.status, real.json.detail]).toEqual([401, none.json.detail])
  })

  it('leaves health and sign-in at the root, and counts calls against the same limit', async () => {
    expect((await at(key, '/p/loud/api/health')).status).toBe(404)
    expect((await at(key, '/p/loud/api/session')).status).toBe(404)
    // However the path is spelt: a percent-encoded letter is the same path to the router
    for (const path of ['/api/%68ealth', '/api/%73ession', '/api/%73ession/claim', '/%61pi/health']) {
      expect([path, (await at(key, `/p/loud${path}`)).status]).toEqual([path, 404])
      expect([path, (await at(null, `/p/nope${path}`)).status]).toEqual([path, 401])
    }
    const signIn = await at(null, '/p/loud/api/%73ession', { method: 'POST', body: { key: OWNER } })
    expect(signIn.status).toBe(401)
    expect(signIn.headers.get('set-cookie')).toBeNull()
    // An encoded path that is neither still reaches the pack
    expect((await at(key, '/p/loud/api/%6de')).json.pack.name).toBe('loud')
    expect((await at(key, '/p/loud/u/fixture/mcp', { method: 'POST', body: {} })).status).toBe(404)
    const ran = await at(key, '/p/loud/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.echo', arguments: { text: 'counted' } },
    })
    expect(ran.status).toBe(200)
    expect(ran.headers.get('ratelimit-policy')).toContain('tool-calls')
    // The kit's pointer to the gateway's own documents is not sent from a pack's address
    expect((await at(key, '/p/loud/api')).headers.get('link')).toBeNull()
    expect((await at(key, '/api')).headers.get('link')).toContain('service-desc')
  })

  it('serves MCP itself and nothing beside it: the public server card stays the gateway’s, at the root', async () => {
    // No route, with a key or without, for a pack that exists and one that does not alike
    for (const pack of ['loud', 'nope'])
      for (const bearer of [null, key])
        expect([pack, (await at(bearer, `/p/${pack}/mcp/server-card`)).status]).toEqual([pack, 404])
    const card = await at(null, '/mcp/server-card')
    expect(card.status).toBe(200)
    expect(card.json.remotes[0].url).toBe('http://localhost/mcp')
  })

  it('lets the owner in as a write key of the pack would be', async () => {
    const me = await owner('/p/loud/api/me')
    expect(me.status).toBe(200)
    expect(me.json).toMatchObject({
      id: 'owner',
      owner: false,
      scope: 'write',
      upstreams: ['fixture'],
      pack: { name: 'loud', title: 'Loud' },
    })
    expect(me.json.packs.map((pack: { name: string }) => pack.name)).toEqual(['loud'])
    expect(namesOf((await owner('/p/loud/api/tools')).json._embedded.tools)).toEqual(['fixture.echo', 'fixture.shout'])
    expect((await owner('/p/loud/api/tools/fixture.greet')).status).toBe(404)
    const ran = await owner('/p/loud/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.shout', arguments: { text: 'mine' } },
    })
    expect(ran.json.result.content[0].text).toBe('MINE')
    const none = await owner('/p/nope/api/me')
    expect(none.status).toBe(403)
    expect(none.json.detail).toBe('No pack nope. GET /api/packs lists them.')
    // At the root the owner is the owner, as before
    expect((await owner('/api/me')).json).toMatchObject({ owner: true, pack: null })
  })

  it('refuses the owner every route that manages the gateway from inside a pack', async () => {
    const made = await owner('/p/loud/api/clients', { method: 'POST', body: { name: 'no', upstreams: 'all' } })
    expect(made.status).toBe(403)
    expect(made.json.detail).toBe(
      'This request is for the pack loud only: manage the gateway at /api or in /app, without a pack.',
    )
    // What a pack serves; every other route a pack's address reaches must refuse the owner there
    const served = [
      '/api',
      '/api/me',
      '/api/tools',
      '/api/tools/openapi.json',
      '/api/calls',
      '/api/upstreams',
      '/api/playbooks',
      '/api/manuals',
      '/api/links',
      '/api/resources',
    ]
    const doc = (await owner('/openapi.json')).json as { paths: Record<string, { get?: unknown }> }
    const reads = Object.entries(doc.paths)
      .filter(([path, item]) => item.get && !path.includes('{') && path.startsWith('/api'))
      .map(([path]) => path)
      .filter((path) => !/^\/api\/(health|session)/.test(path))
    expect(reads).toEqual(expect.arrayContaining(served))
    const answers = await Promise.all(
      reads.map(async (path) => [path, (await at(OWNER, `/p/loud${path}`)).status] as const),
    )
    expect(
      answers.filter(([path, status]) => (served.includes(path) ? ![200, 400].includes(status) : status !== 403)),
    ).toEqual([])
  })

  it('refuses a pack the key does not open, naming the addresses of those it does', async () => {
    const refused = await api(key, '/p/quiet/api/me')
    expect(refused.status).toBe(403)
    expect(refused.json.detail).toBe(
      "This key doesn't open the pack quiet. It opens desk (/p/desk/mcp), loud (/p/loud/mcp).",
    )
  })

  type Linked = { _links?: Record<string, { href: string }>; _embedded?: Record<string, Linked[]> }
  /** Every link of an answer: its own and those of what it embeds. */
  const hrefsOf = (json: Linked): string[] => [
    ...Object.values(json._links ?? {}).map((link) => link.href),
    ...Object.values(json._embedded ?? {}).flatMap((items) => items.flatMap(hrefsOf)),
  ]

  it('keeps the links it hands out inside the pack’s address', async () => {
    const inside = 'http://localhost/p/loud/'
    const paths = [
      '/api',
      '/api/me',
      '/api/tools',
      '/api/tools/fixture.echo',
      '/api/upstreams',
      '/api/upstreams/fixture',
      '/api/calls',
      '/api/playbooks',
      '/api/manuals',
    ]
    for (const path of paths) {
      const answer = await at(key, `/p/loud${path}`)
      const hrefs = hrefsOf(answer.json)
      expect([path, answer.status, hrefs.length > 0]).toEqual([path, 200, true])
      expect(hrefs.filter((href) => !href.startsWith(inside))).toEqual([])
      expect(answer.headers.get('content-type')).toContain('application/hal+json')
      expect(answer.headers.get('link')).toBeNull()
      // The old ways to name a pack keep the links at the root
      const byHeader = hrefsOf((await at(key, path, { headers: { 'x-gateway-pack': 'loud' } })).json)
      expect(byHeader.filter((href) => href.includes('/p/loud/'))).toEqual([])
    }
    const tools = (await api(key, '/p/loud/api/tools?upstream=fixture')).json
    expect(tools._embedded.tools[0]._links).toMatchObject({
      self: { href: `${inside}api/tools/fixture.echo` },
      call: { href: `${inside}api/tools/fixture.echo/calls` },
      upstream: { href: `${inside}api/upstreams/fixture` },
    })
    const ran = await api(key, '/p/loud/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.echo', arguments: { text: 'linked' } },
    })
    expect(ran.json._links.self.href).toBe(`${inside}api/calls/${ran.json.id}`)
    expect(ran.json._links.tool.href).toBe(`${inside}api/tools/fixture.echo`)
    expect(ran.json.result.content[0].text).toBe('linked')
    expect((await api(key, '/p/loud/api/tools/openapi.json')).json.servers).toEqual([
      { url: 'http://localhost/p/loud' },
    ])
    expect((await api(key, '/api/tools/openapi.json')).json.servers).toEqual([{ url: 'http://localhost' }])
    expect((await api(key, '/p/loud/api/me')).json.packs.map((pack: { mcpUrl: string }) => pack.mcpUrl)).toEqual([
      'http://localhost/p/desk/mcp',
      'http://localhost/p/loud/mcp',
    ])
  })

  it('over MCP: the gateway’s shape, under the pack’s name and in its words', async () => {
    const client = await mcp(key, '/p/loud/mcp')
    expect(client.getServerVersion()).toMatchObject({
      name: 'loud',
      title: 'Loud',
      description: 'Say things back, loudly.',
      websiteUrl: `${app.services.publicOrigin}/p/loud/llms.txt`,
    })
    const listed = (await client.listTools()).tools
    expect(namesOf(listed).sort()).toEqual([...META, 'fixture.echo', 'fixture.shout'].sort())
    const instructions = client.getInstructions() ?? ''
    expect(instructions).toMatch(/^Loud: Say things back, loudly\./)
    expect(instructions).toContain('Every tool of this pack is listed here')
    expect(instructions).toContain('search_tools')
    expect(instructions).toMatch(/Front desk \(http:\/\/[^)]+\/p\/desk\/mcp\)/)
    // The connection as the pack holds it: two tools and its manual
    expect(instructions).toMatch(/^- fixture: Fixture \(2 tools, 1 playbook\) \[manual\]$/m)
    expect(instructions).toContain('- fixture.shout:')
    // Nothing a pack's agent reads speaks of the gateway (the gateway:// addresses stay)
    const prompts = (await client.listPrompts()).prompts
    const words = [
      ...listed.filter((tool) => META.includes(tool.name)).map((tool) => `${tool.title} ${tool.description}`),
      ...prompts.map((prompt) => `${prompt.title} ${prompt.description}`),
      instructions,
    ]
    expect(words.filter((text) => /this gateway|behind the gateway|the gateway’s|Yardhand/.test(text))).toEqual([])
    expect(listed.find((tool) => tool.name === 'search_tools')?.description).toContain('Finds tools in Loud')
    expect(listed.find((tool) => tool.name === 'call_tool')?.description).toContain('Runs a tool of Loud')
    expect(namesOf(prompts)).toEqual(['use_pack', 'fixture-say-it-back'])
    expect(prompts[0]?.title).toBe('Do a task with Loud’s tools')
    expect(await said(client, 'call_tool', { name: 'fixture.shout', arguments: { text: 'hey' } })).toBe('HEY')
    expect(await said(client, 'search_tools', { query: 'shout' })).toContain('fixture.shout [changes things]')
    expect(await said(client, 'search_tools', { query: 'zzqx' })).toContain('Nothing in Loud matches "zzqx".')
    expect(await said(client, 'list_upstreams')).toContain('fixture: Fixture, 2 tools, 1 playbook')
    // What the connection reads from the API links inside the pack's address, as the API there does
    const read = async (from: Client) =>
      ((await from.readResource({ uri: 'gateway://tools/fixture.shout' })).contents[0] as { text: string }).text
    expect(await read(client)).toMatch(/"href": ?"http:\/\/[^"/]+\/p\/loud\/api\/tools\/fixture\.shout"/)
    await client.close()
    expect((await api(key, '/p/loud/api/upstreams/fixture')).json).toMatchObject({
      toolCount: 2,
      offers: { playbooks: 1, manuals: 1, links: 0 },
    })
    // The same connection by the old address, and the key's default pack at plain /mcp
    const legacy = await mcp(key, '/mcp/p/loud')
    expect(legacy.getServerVersion()).toMatchObject({ name: 'loud', title: 'Loud' })
    expect(namesOf((await legacy.listTools()).tools).sort()).toEqual([...META, 'fixture.echo', 'fixture.shout'].sort())
    expect(await read(legacy)).toMatch(/"href": ?"http:\/\/[^"/]+\/api\/tools\/fixture\.shout"/)
    await legacy.close()
    const plain = await mcp(key, '/mcp')
    expect(plain.getServerVersion()).toMatchObject({ name: 'desk', title: 'Front desk' })
    expect(plain.getInstructions()).toMatch(/Loud \(http:\/\/[^)]+\/p\/loud\/mcp\)/)
    await plain.close()
    // The owner there is served the pack too; at the root, the gateway as before
    const mine = await mcp(OWNER, '/p/loud/mcp')
    expect(mine.getServerVersion()).toMatchObject({ name: 'loud' })
    expect(namesOf((await mine.listTools()).tools).sort()).toEqual([...META, 'fixture.echo', 'fixture.shout'].sort())
    await mine.close()
    const root = await mcp(OWNER)
    expect(root.getServerVersion()).toMatchObject({ name: 'yardhand', title: 'Yardhand' })
    expect(namesOf((await root.listPrompts()).prompts)).toContain('use_gateway')
    await root.close()
  })

  it('over MCP with the header: the pack it names, for everything the connection does', async () => {
    const header = { 'x-gateway-pack': 'loud' }
    const mine = await mcp(OWNER, '/mcp', header)
    expect(mine.getServerVersion()).toMatchObject({ name: 'loud', title: 'Loud' })
    expect(namesOf((await mine.listTools()).tools).sort()).toEqual([...META, 'fixture.echo', 'fixture.shout'].sort())
    expect(mine.getInstructions()).toMatch(/^Loud: Say things back, loudly\./)
    // A tool outside the pack is neither found nor run
    expect(await said(mine, 'search_tools', { query: 'greet' })).not.toContain('fixture.greet')
    const outside = await mine.callTool({ name: 'call_tool', arguments: { name: 'fixture.greet', arguments: {} } })
    expect(outside.isError).toBe(true)
    expect((outside.content as { text: string }[])[0]?.text).toContain('is not in Loud')
    expect(await said(mine, 'call_tool', { name: 'fixture.shout', arguments: { text: 'hey' } })).toBe('HEY')
    await mine.close()
    // A key with several packs gets the one it names, not its default
    const named = await mcp(key, '/mcp', header)
    expect(named.getServerVersion()).toMatchObject({ name: 'loud', title: 'Loud' })
    const listed = namesOf((await named.listTools()).tools)
    expect(listed).toContain('fixture.shout')
    expect(listed).not.toContain('greet_from_desk')
    await named.close()
    // Links stay at the root, as the header always answered
    const tools = (await at(key, '/api/tools', { headers: header })).json
    expect(tools._links.self.href).toBe('http://localhost/api/tools')
    const refused = await at(OWNER, '/mcp', {
      method: 'POST',
      headers: { ...header, 'x-gateway-pack': 'nope', accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(refused.status).toBe(403)
  })

  it('greets a client that still opens with initialize as the pack, too', async () => {
    // A 2026-07-28 client has no initialize; one sent out of habit is answered with what server/discover would say
    const greeted = async (bearer: string, path: string, headers: Record<string, string> = {}) => {
      const answer = await at(bearer, path, {
        method: 'POST',
        headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', ...headers },
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        },
      })
      expect(answer.status).toBe(200)
      return answer.json.result as { serverInfo: { name: string; title: string }; instructions: string }
    }
    const loud = await greeted(key, '/p/loud/mcp')
    expect(loud.serverInfo).toMatchObject({ name: 'loud', title: 'Loud' })
    expect(loud.instructions).toMatch(/^Loud: Say things back, loudly\./)
    expect(loud.instructions).toContain('- fixture: Fixture (2 tools, 1 playbook) [manual]')
    expect(loud.instructions).toContain('no initialize or session is needed')
    expect((await greeted(key, '/mcp/p/loud')).serverInfo.name).toBe('loud')
    expect((await greeted(key, '/mcp')).serverInfo.name).toBe('desk')
    expect((await greeted(OWNER, '/p/loud/mcp')).serverInfo.name).toBe('loud')
    expect((await greeted(OWNER, '/mcp', { 'x-gateway-pack': 'loud' })).serverInfo.name).toBe('loud')
    expect((await greeted(key, '/mcp', { 'x-gateway-pack': 'loud' })).serverInfo.name).toBe('loud')
    const root = await greeted(OWNER, '/mcp')
    expect(root.serverInfo).toMatchObject({ name: 'yardhand', title: 'Yardhand' })
    expect(root.instructions).toMatch(/^Yardhand: one MCP server in front of many\./)
  })

  it('introduces itself as the pack at /api, and offers the owner a look as one of its keys', async () => {
    const home = (await api(key, '/p/loud/api')).json
    expect(home).toMatchObject({ name: 'Loud', upstreams: 1 })
    expect(home.description).toContain('Say things back, loudly.')
    expect(home.description).toContain('/p/loud/mcp')
    expect(home._links).toMatchObject({
      self: { href: 'http://localhost/p/loud/api' },
      openapi: { href: 'http://localhost/p/loud/openapi.json' },
      docs: { href: 'http://localhost/p/loud/docs' },
      guide: { href: 'http://localhost/p/loud/llms.txt' },
      mcp: { href: 'http://localhost/p/loud/mcp' },
    })
    expect(home._links.seeAs).toBeUndefined()
    expect(home._links.clients).toBeUndefined()
    const mine = (await owner('/p/loud/api')).json
    expect(mine._links.seeAs).toEqual({
      href: 'http://localhost/p/loud/api/tools{?as}',
      title: 'This pack as one of its keys sees it',
      templated: true,
    })
    expect((await owner('/api')).json).toMatchObject({ name: 'Yardhand' })
    expect((await owner('/api')).json._links.seeAs).toBeUndefined()
  })

  it('can be walked from /p/<pack>/api without ever leaving the pack’s address', async () => {
    const inside = 'http://localhost/p/loud/'
    const seen = new Set<string>()
    const queue = [`${inside}api`]
    const left: string[] = []
    const failed: [string, number][] = []
    while (queue.length) {
      const href = queue.shift() as string
      if (seen.has(href)) continue
      seen.add(href)
      if (!href.startsWith(inside)) {
        left.push(href)
        continue
      }
      const answer = await at(key, href.slice('http://localhost'.length))
      if (answer.status !== 200) failed.push([href, answer.status])
      const links = [
        answer.json ?? {},
        ...Object.values((answer.json?._embedded ?? {}) as Record<string, object[]>).flat(),
      ]
        .flatMap((item: Linked & { _links?: Record<string, { href: string; templated?: boolean }> }) =>
          Object.entries(item._links ?? {}),
        )
        .filter(([rel, link]) => rel !== 'call' && rel !== 'mcp' && !link.templated)
      queue.push(...links.map(([, link]) => link.href))
    }
    expect(left).toEqual([])
    expect(failed).toEqual([])
    // The pack's documents were among them
    for (const page of ['openapi.json', 'docs', 'llms.txt', 'api/tools/openapi.json', 'api/calls'])
      expect(seen).toContain(`${inside}${page}`)
    expect(seen.size).toBeGreaterThan(15)
  })

  it('links a call to its tool only under a name the pack holds', async () => {
    // Made in the key's other pack, logged under the tool's own name, which Loud has no name for
    await api(key, '/api/calls', { method: 'POST', body: { tool: 'greet_from_desk', arguments: { to: 'Flo' } } })
    const log = (await api(key, '/p/loud/api/calls?limit=100')).json._embedded.calls as {
      id: string
      tool: string
      _links: Record<string, { href: string } | undefined>
    }[]
    const greets = log.filter((call) => call.tool === 'fixture.greet')
    expect(greets.length).toBeGreaterThan(0)
    expect(greets.filter((call) => call._links.tool)).toEqual([])
    const echo = log.find((call) => call.tool === 'fixture.echo')
    expect(echo?._links.tool?.href).toBe('http://localhost/p/loud/api/tools/fixture.echo')
    const one = (await api(key, `/p/loud/api/calls/${greets[0]?.id}`)).json
    expect(one._links.tool).toBeUndefined()
    expect(one._links.self.href).toBe(`http://localhost/p/loud/api/calls/${greets[0]?.id}`)
  })

  it('is in the gateway’s guide: every address named there is served, the older ways beside them', async () => {
    // On one line: the guide is wrapped by hand
    const guide = (await at(key, '/llms.txt')).text.replace(/\s+/g, ' ')
    const named = [...new Set(guide.match(/\/p\/<pack>\/[a-z.]+/g))].sort()
    expect(named).toEqual([
      '/p/<pack>/api',
      '/p/<pack>/docs',
      '/p/<pack>/llms.txt',
      '/p/<pack>/mcp',
      '/p/<pack>/openapi.json',
    ])
    for (const path of named.filter((path) => !path.endsWith('/mcp')))
      expect([path, (await at(key, path.replace('<pack>', 'loud'))).status]).toEqual([path, 200])
    expect(guide).toContain('`/mcp/p/<pack>`')
    expect(guide).toContain('`x-gateway-pack')
    // What a pack connection lists, as `pinnedBy` decides it
    expect(guide).toContain('every tool of the pack')
    expect(guide).toContain('pins of its own')
  })

  it('answers an Idempotency-Key reused at the key’s other pack with the first answer, as the guide warns', async () => {
    const send = (pack: string) =>
      at(key, `/p/${pack}/api/calls`, {
        method: 'POST',
        headers: { 'idempotency-key': 'one-key-two-packs' },
        body: { tool: 'fixture.shout', arguments: { text: 'once' } },
      })
    const first = await send('loud')
    expect(first.json.result.content[0].text).toBe('ONCE')
    // Front desk holds no fixture.shout: this is Loud's answer again, not a refusal
    const again = await send('desk')
    expect(again.headers.get('idempotent-replayed')).toBe('true')
    expect(again.json.id).toBe(first.json.id)
    // The links of a replay are those of the address asking now, not of the one that asked first
    expect(first.json._links.self.href).toBe(`http://localhost/p/loud/api/calls/${first.json.id}`)
    expect(again.json._links.self.href).toBe(`http://localhost/p/desk/api/calls/${first.json.id}`)
    const replay = (path: string, id: string) =>
      at(OWNER, path, {
        method: 'POST',
        headers: { 'idempotency-key': id },
        body: { tool: 'fixture.shout', arguments: { text: 'twice' } },
      })
    const rootFirst = await replay('/api/calls', 'root-then-pack')
    expect(rootFirst.json._links.self.href).toBe(`http://localhost/api/calls/${rootFirst.json.id}`)
    const packAfter = await replay('/p/loud/api/calls', 'root-then-pack')
    expect(packAfter.headers.get('idempotent-replayed')).toBe('true')
    expect(packAfter.json._links.self.href).toBe(`http://localhost/p/loud/api/calls/${rootFirst.json.id}`)
    const packFirst = await replay('/p/loud/api/calls', 'pack-then-root')
    const rootAfter = await replay('/api/calls', 'pack-then-root')
    expect(rootAfter.headers.get('idempotent-replayed')).toBe('true')
    expect(rootAfter.json._links.self.href).toBe(`http://localhost/api/calls/${packFirst.json.id}`)
    const guide = (await at(key, '/llms.txt')).text.replace(/\s+/g, ' ')
    expect(guide).toContain('a new `Idempotency-Key` for each new request')
  })
})

describe('pins inside a pack', () => {
  const DESK = ['greet_from_desk', 'fixture.greet', 'fixture.echo']
  const pinsOf = async (key: string, path = '/api/me') => namesOf((await api(key, path)).json.pins)
  const listedAt = async (key: string, path = '/mcp') => {
    const client = await mcp(key, path)
    const names = namesOf((await client.listTools()).tools)
    await client.close()
    return names
  }
  const instructionsAt = async (key: string, path = '/mcp') => {
    const client = await mcp(key, path)
    const told = client.getInstructions() ?? ''
    await client.close()
    return told
  }
  const pin = (id: string, body: Record<string, unknown>) => owner(`/api/clients/${id}`, { method: 'PATCH', body })
  let desk = { id: '', key: '' }
  let two = { id: '', key: '' }
  beforeAll(async () => {
    desk = await keyFor({ name: 'desk-pinner', pack: 'desk' })
    two = await keyFor({ name: 'two-pinner', packs: ['desk', 'loud'], pack: 'desk' })
  })

  it('lists the whole pack and the meta-tools for a key without pins of its own', async () => {
    expect(await pinsOf(desk.key)).toEqual(DESK)
    expect((await api(desk.key, '/api/me')).json.pack.ownPins).toBe(false)
    expect((await listedAt(desk.key)).sort()).toEqual([...META, ...DESK].sort())
    expect(await instructionsAt(desk.key)).toContain('Every tool of this pack is listed here')
    const cards = (await api(desk.key, '/api/tools')).json._embedded.tools
    expect(cards.map((card: { pinned: boolean }) => card.pinned)).toEqual([true, true, true])
  })

  it('narrows a key to its own pins, by the pack’s names; the rest is found by search', async () => {
    const pinned = await pin(desk.id, { pins: ['greet_from_desk'] })
    expect(pinned.status).toBe(200)
    expect(pinned.json.pins).toEqual(['greet_from_desk'])
    const me = (await api(desk.key, '/api/me')).json
    expect(namesOf(me.pins)).toEqual(['greet_from_desk'])
    expect(me.pack.ownPins).toBe(true)
    expect(Object.keys(me.pins[0].inputSchema.properties)).toEqual(['to'])
    expect((await listedAt(desk.key)).sort()).toEqual([...META, 'greet_from_desk'].sort())
    const told = await instructionsAt(desk.key)
    expect(told).toContain('Your pinned tools are listed here')
    expect(told).toContain('- greet_from_desk:')
    expect(told).not.toContain('- fixture.echo:')
    expect(told).toMatch(/^- fixture: Fixture \(3 tools\)$/m)
    const cards = (await api(desk.key, '/api/tools')).json._embedded.tools
    expect(
      Object.fromEntries(cards.map((card: { name: string; pinned: boolean }) => [card.name, card.pinned])),
    ).toEqual({ greet_from_desk: true, 'fixture.greet': false, 'fixture.echo': false })
    const client = await mcp(desk.key)
    const direct = await client.callTool({ name: 'greet_from_desk', arguments: { to: 'Ed' } })
    expect((direct.content as { text: string }[])[0]?.text).toBe('Hello Ed, from the desk')
    const found = await client.callTool({ name: 'search_tools', arguments: { query: 'echo' } })
    expect((found.content as { text: string }[])[0]?.text).toContain('fixture.echo')
    const ran = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'fixture.echo', arguments: { text: 'unpinned' } },
    })
    expect((ran.content as { text: string }[])[0]?.text).toBe('unpinned')
    await client.close()
  })

  it('refuses a pin that is not a name in the key’s packs', async () => {
    const refused = await pin(desk.id, { pins: ['greet_from_desk', 'fixture.shout'] })
    expect(refused.status).toBe(400)
    expect(refused.json.detail).toBe(
      "Not a name in this key's packs: fixture.shout. GET /api/packs/{name} lists a pack's names.",
    )
    expect(await pinsOf(desk.key)).toEqual(['greet_from_desk'])
    const made = await owner('/api/clients', {
      method: 'POST',
      body: { name: 'bad-pins', pack: 'desk', pins: ['fixture.nope'] },
    })
    expect(made.status).toBe(400)
  })

  it('makes a pack key with pins, and lists only the meta-tools for an empty pin list', async () => {
    const made = await keyFor({ name: 'made-pinned', pack: 'desk', pins: ['fixture.echo', 'greet_from_desk'] })
    expect(await pinsOf(made.key)).toEqual(['fixture.echo', 'greet_from_desk'])
    expect((await pin(made.id, { pins: [] })).status).toBe(200)
    expect(await pinsOf(made.key)).toEqual([])
    expect((await listedAt(made.key)).sort()).toEqual(META)
    await owner(`/api/clients/${made.id}`, { method: 'DELETE' })
  })

  it('keeps the global pins out of a pack: they neither narrow nor widen it', async () => {
    expect((await owner('/api/pins', { method: 'PUT', body: { tools: ['fixture.shout'] } })).status).toBe(200)
    expect(await pinsOf(two.key)).toEqual(DESK)
    expect(await pinsOf(two.key, '/p/loud/api/me')).toEqual(['fixture.echo', 'fixture.shout'])
    expect(await pinsOf(desk.key)).toEqual(['greet_from_desk'])
    expect((await owner('/api/pins', { method: 'PUT', body: { tools: [] } })).status).toBe(200)
  })

  it('gives a key with several packs one pin list: each pack lists the names it holds', async () => {
    expect((await pin(two.id, { pins: ['fixture.shout', 'greet_from_desk'] })).status).toBe(200)
    expect(await pinsOf(two.key)).toEqual(['greet_from_desk'])
    expect(await pinsOf(two.key, '/p/loud/api/me')).toEqual(['fixture.shout'])
    expect((await listedAt(two.key, '/p/loud/mcp')).sort()).toEqual([...META, 'fixture.shout'].sort())
    // Pins that all sit in its other pack leave this one with the meta-tools alone
    expect((await pin(two.id, { pins: ['greet_from_desk'] })).status).toBe(200)
    expect(await pinsOf(two.key, '/p/loud/api/me')).toEqual([])
    expect((await listedAt(two.key, '/p/loud/mcp')).sort()).toEqual(META)
    expect(await instructionsAt(two.key, '/p/loud/mcp')).toContain('No tool of this pack is listed here')
    // Pins sent with new packs are checked against the packs the key is left with
    const moved = await pin(two.id, { packs: ['loud'], pins: ['greet_from_desk'] })
    expect(moved.status).toBe(400)
    expect((await owner(`/api/clients/${two.id}`)).json.packs).toEqual(['desk', 'loud'])
  })

  it('does not list a read-only key’s pin of a tool that changes things', async () => {
    const reader = await keyFor({ name: 'loud-pinned-reader', pack: 'loud', scope: 'read', pins: ['fixture.shout'] })
    expect(await pinsOf(reader.key)).toEqual([])
    expect((await pin(reader.id, { pins: ['fixture.shout', 'fixture.echo'] })).status).toBe(200)
    expect(await pinsOf(reader.key)).toEqual(['fixture.echo'])
  })

  it('brings the whole pack back when a key’s pins are cleared', async () => {
    const cleared = await pin(desk.id, { pins: null })
    expect(cleared.json.pins).toBeNull()
    expect(await pinsOf(desk.key)).toEqual(DESK)
    expect((await listedAt(desk.key)).sort()).toEqual([...META, ...DESK].sort())
    expect((await pin(two.id, { pins: null })).status).toBe(200)
    expect(await pinsOf(two.key, '/p/loud/api/me')).toEqual(['fixture.echo', 'fixture.shout'])
  })

  it('keeps a meta-tool’s name for the meta-tool when a pack names a tool the same', async () => {
    await owner('/api/packs', { method: 'POST', body: { name: 'clash', title: 'Clash', description: 'A name clash.' } })
    const added = await owner('/api/packs/clash', {
      method: 'PATCH',
      body: { add: { tools: [{ name: 'fixture.echo', alias: 'search_tools' }, { name: 'fixture.shout' }] } },
    })
    expect(added.status).toBe(200)
    const made = await keyFor({ name: 'clash-agent', pack: 'clash' })
    expect(await pinsOf(made.key)).toEqual(['search_tools', 'fixture.shout'])
    const client = await mcp(made.key)
    const listed = (await client.listTools()).tools
    expect(namesOf(listed).sort()).toEqual([...META, 'fixture.shout'].sort())
    expect(listed.find((tool) => tool.name === 'search_tools')?.title).toBe('Find tools')
    // The pack's tool of that name still runs through call_tool
    const ran = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'search_tools', arguments: { text: 'still here' } },
    })
    expect((ran.content as { text: string }[])[0]?.text).toBe('still here')
    await client.close()
    await owner(`/api/clients/${made.id}`, { method: 'DELETE' })
    expect((await owner('/api/packs/clash', { method: 'DELETE' })).status).toBe(204)
  })
})

describe('packs in the config', () => {
  it('leave with an export and come back on a fresh gateway, filled in once their upstream syncs', async () => {
    await owner('/api/packs/loud/tools/fixture.echo/wording', {
      method: 'PUT',
      body: { description: 'Says it back. Loud pack wording.' },
    })
    const exported = (await owner('/api/config')).json
    expect(exported.packs[0]).toMatchObject({
      name: 'desk',
      tools: [
        expect.objectContaining({ name: 'fixture.greet', alias: 'greet_from_desk', fixed: { from: 'the desk' } }),
        expect.objectContaining({ name: 'fixture.greet', alias: null, fixed: null }),
        expect.objectContaining({ name: 'fixture.echo', alias: null }),
      ],
    })
    expect(exported.packs.slice(1)).toEqual([
      {
        name: 'loud',
        title: 'Loud',
        description: 'Say things back, loudly.',
        tools: [
          {
            name: 'fixture.echo',
            reason: 'named',
            via: 'fixture-say-it-back',
            wording: 'Says it back. Loud pack wording.',
            alias: null,
            fixed: null,
          },
          {
            name: 'fixture.shout',
            reason: 'named',
            via: 'fixture-say-it-back',
            wording: null,
            alias: null,
            fixed: null,
          },
        ],
        playbooks: ['fixture-say-it-back'],
        manuals: ['fixture'],
      },
    ])
    expect(exported.clients).toContainEqual(expect.objectContaining({ name: 'loud-reader', pack: 'loud' }))

    const fresh = await createApp({
      db: await testDb(),
      env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
    })
    const send = async (path: string, method: string, body: unknown) => {
      const response = await fresh.request(path, {
        method,
        headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return (await response.json()) as any
    }
    // The upstream waits for its credential, so the pack comes back empty and says what it is waiting for
    const first = await send('/api/config', 'POST', exported)
    expect(first.packs).toEqual({ created: ['desk', 'loud'], filled: [] })
    expect(first.skipped).toEqual(
      expect.arrayContaining([
        'pack loud tool fixture.echo: not live yet',
        'pack loud playbook fixture-say-it-back: not live yet',
        'pack desk tool greet_from_desk: not live yet',
      ]),
    )

    await send('/api/upstreams/fixture', 'PATCH', { auth: { type: 'bearer', value: 'fixture-token' } })
    const second = await send('/api/config', 'POST', exported)
    expect(second.packs).toEqual({ created: [], filled: ['desk', 'loud'] })
    expect(second.skipped.filter((line: string) => line.startsWith('pack'))).toEqual([])

    const pack = (await (
      await fresh.request('/api/packs/loud', { headers: { authorization: `Bearer ${OWNER}` } })
    ).json()) as any
    expect(pack.tools).toEqual([
      expect.objectContaining({
        name: 'fixture.echo',
        reason: 'named',
        wording: 'Says it back. Loud pack wording.',
        flag: null,
      }),
      expect.objectContaining({ name: 'fixture.shout', wording: null }),
    ])
    expect(pack.playbooks.map((item: { name: string }) => item.name)).toEqual(['fixture-say-it-back'])
    const desk = (await (
      await fresh.request('/api/packs/desk', { headers: { authorization: `Bearer ${OWNER}` } })
    ).json()) as any
    expect(
      desk.tools.map((tool: { name: string; tool: string; fixed: object }) => [tool.name, tool.tool, tool.fixed]),
    ).toEqual([
      ['greet_from_desk', 'fixture.greet', { from: 'the desk' }],
      ['fixture.greet', 'fixture.greet', {}],
      ['fixture.echo', 'fixture.echo', {}],
    ])
    expect(pack.manuals.map((item: { name: string }) => item.name)).toEqual(['fixture'])

    // A third import changes nothing
    expect((await send('/api/config', 'POST', exported)).packs).toEqual({ created: [], filled: [] })
  })
})
