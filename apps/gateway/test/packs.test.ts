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
const mcp = async (key: string, path = '/mcp') => {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(path, origin), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
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
    expect(client.getInstructions()).toMatch(/^Quiet: Only echo\./)
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
      { name: 'desk', title: 'Front desk', mcpUrl: 'http://localhost/mcp/p/desk', default: true },
      { name: 'loud', title: 'Loud', mcpUrl: 'http://localhost/mcp/p/loud', default: false },
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
      "This key doesn't open the pack quiet. It opens desk (/mcp/p/desk), loud (/mcp/p/loud).",
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
    expect(claude.snippet).toContain('gw-desk http://localhost/mcp/p/desk')
    expect(claude.snippet).toContain('gw-loud http://localhost/mcp/p/loud')
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
    const ownerAsked = await app.request('/api/me', {
      headers: { authorization: `Bearer ${OWNER}`, 'x-gateway-pack': 'desk' },
    })
    expect(ownerAsked.status).toBe(403)
  })

  it('counts as a key of every pack it opens', async () => {
    expect((await owner('/api/packs/loud')).json.keyList.map((key: { name: string }) => key.name)).toContain(
      'two-packs',
    )
    expect((await owner('/api/packs/desk', { method: 'DELETE' })).status).toBe(409)
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
