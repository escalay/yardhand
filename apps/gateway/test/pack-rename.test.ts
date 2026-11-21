/**
 * Renaming a pack: its address moves, and when it has keys the old name keeps leading to it, served in place over
 * MCP and REST and sending a reader of its pages on. A key that does not open the pack learns nothing from the old
 * name, and no other pack can take it until the owner frees it or the pack goes.
 */
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { dayOf } from '../src/features/clients/lifetimes.js'
import { packsRepo } from '../src/features/packs/repo.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-renaming'
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
/** An answer with its headers, with a key or (null) without credentials. Nothing follows a redirect here. */
const at = async (key: string | null, path: string, init: Init = {}) => {
  const response = await app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      'content-type': 'application/json',
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  return { status: response.status, headers: response.headers, json: (await response.json().catch(() => null)) as any }
}
const owner = (path: string, init?: Init) => at(OWNER, path, init)
const mcp = async (key: string, path = '/mcp', headers: Record<string, string> = {}) => {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(path, origin), {
      requestInit: { headers: { authorization: `Bearer ${key}`, ...headers } },
    }),
  )
  return client
}
/** A tools/list sent as it is, with no session: what the door answers. */
const knock = (key: string, path: string, headers: Record<string, string> = {}) =>
  at(key, path, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', ...headers },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  })
type Made = { id: string; key: string }
const keyFor = async (body: Record<string, unknown>) => {
  const made = await owner('/api/clients', { method: 'POST', body: { scope: 'write', ...body } })
  expect(made.status).toBe(201)
  return made.json as Made
}
const packOf = async (name: string, title: string) => {
  const made = await owner('/api/packs', {
    method: 'POST',
    body: { name, title, description: `What ${title} is for.` },
  })
  expect(made.status).toBe(201)
  const filled = await owner(`/api/packs/${name}`, {
    method: 'PATCH',
    body: { add: { tools: [{ name: 'fixture.echo' }, { name: 'fixture.shout' }] } },
  })
  expect(filled.json.counts.tools).toBe(2)
}
const rename = (from: string, to: string) => owner(`/api/packs/${from}`, { method: 'PATCH', body: { name: to } })
const formerOf = async (name: string) =>
  ((await owner(`/api/packs/${name}`)).json.formerNames as { name: string; until: string; people: number }[]).map(
    ({ name: former, people }) => ({ name: former, people }),
  )
const namesOf = (items: { name: string }[]) => items.map((item) => item.name)
const unknown = (name: string) => `No pack ${name}. GET /api/packs lists them.`
const renamed = (from: string, to: string) => `No pack ${from}: it was renamed to ${to}. GET /api/packs/${to}.`

let sam: Made
let both: Made

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
  await packOf('shed', 'Garden')
  await packOf('desk', 'Desk')
  sam = await keyFor({ name: 'Sam', pack: 'shed' })
  both = await keyFor({ name: 'Sam at work', packs: ['shed', 'desk'] })
})

describe('renaming a pack', () => {
  it('moves it to its new address and lists the name it had', async () => {
    const moved = await rename('shed', 'garden')
    expect(moved.status).toBe(200)
    expect(moved.json).toMatchObject({ name: 'garden', title: 'Garden', counts: { tools: 2 }, keys: 2 })
    expect(new URL(moved.json._links.self.href).pathname).toBe('/api/packs/garden')
    expect(moved.json.formerNames).toEqual([{ name: 'shed', until: expect.any(String), people: 0 }])
    expect(dayOf(moved.json.formerNames[0].until)).toBe(dayOf(new Date().toISOString()))
    expect((await owner('/api/packs/garden')).status).toBe(200)
    expect((await owner('/api/packs/shed')).status).toBe(404)
    expect(namesOf((await owner('/api/packs')).json._embedded.packs)).toEqual(['desk', 'garden'])
    // Its keys are its keys under any name
    for (const made of [sam, both])
      expect((await owner(`/api/clients/${made.id}`)).json.packs).toEqual(expect.arrayContaining(['garden']))
    expect((await at(sam.key, '/api/packs/garden', { method: 'PATCH', body: { name: 'mine' } })).status).toBe(403)
  })

  it('keeps the old name from every later pack: a new one, a renamed one, an imported one', async () => {
    const until = dayOf(new Date().toISOString())
    const taken = `shed still leads to Garden (its name until ${until}), so the people who connect there are not cut off: pick another name, or free it with DELETE /api/packs/garden/names/shed.`
    const made = await owner('/api/packs', { method: 'POST', body: { name: 'shed', title: 'Shed' } })
    expect([made.status, made.json.detail]).toEqual([409, taken])
    const moved = await rename('desk', 'shed')
    expect([moved.status, moved.json.detail]).toEqual([409, taken])
    expect((await owner('/api/packs/desk')).status).toBe(200)
    // A name a pack has now is refused as before
    const same = await rename('desk', 'garden')
    expect([same.status, same.json.detail]).toEqual([409, 'A pack is already named garden: pick another name.'])
    const imported = await owner('/api/config', {
      method: 'POST',
      body: { packs: [{ name: 'shed', title: 'Shed', tools: [{ name: 'fixture.echo' }] }] },
    })
    expect(imported.status).toBe(200)
    expect(imported.json.packs).toEqual({ created: [], filled: [] })
    expect(imported.json.skipped).toEqual([
      'pack shed: the name still leads to garden (free it with DELETE /api/packs/garden/names/shed)',
    ])
    expect(namesOf((await owner('/api/packs')).json._embedded.packs)).toEqual(['desk', 'garden'])
  })

  it('changes nothing when the rest of the change cannot be made', async () => {
    const refused = await owner('/api/packs/garden', {
      method: 'PATCH',
      body: { name: 'plot', title: 'Plot', add: { tools: [{ name: 'fixture.nope' }] } },
    })
    expect(refused.status).toBe(400)
    expect(refused.json.detail).toContain('Not live, so not added: fixture.nope')
    const still = await owner('/api/packs/garden')
    expect([still.status, still.json.title]).toEqual([200, 'Garden'])
    expect(await formerOf('garden')).toEqual([{ name: 'shed', people: 0 }])
    expect((await owner('/api/packs/plot')).json.detail).toBe(unknown('plot'))
    // Its own name again is no rename, and a name with the rest of a change is one change
    expect((await rename('garden', 'garden')).status).toBe(200)
    expect(await formerOf('garden')).toEqual([{ name: 'shed', people: 0 }])
    const whole = await owner('/api/packs/desk', { method: 'PATCH', body: { name: 'bureau', title: 'Bureau' } })
    expect(whole.json).toMatchObject({ name: 'bureau', title: 'Bureau', formerNames: [{ name: 'desk' }] })
    expect((await rename('bureau', 'desk')).json).toMatchObject({ name: 'desk', formerNames: [{ name: 'bureau' }] })
  })

  it('keeps its name and its tools when a tool sent with the new name is refused', async () => {
    const tools = ['fixture.echo', 'fixture.shout']
    for (const [tool, detail] of [
      [
        { name: 'fixture.echo', alias: 'echo_loudly', fixed: { volume: 11 } },
        'Not saved: echo_loudly: fixture.echo has no input volume. GET /api/tools/fixture.echo shows its inputs.',
      ],
      [
        { name: 'fixture.echo', alias: 'echo_loudly', defaults: { text: 7 } },
        'Not saved: echo_loudly: text must be string. GET /api/tools/fixture.echo shows its inputs.',
      ],
      [
        { name: 'fixture.echo', alias: 'search_tools' },
        "search_tools is the name of a tool every pack connection has of its own, so fixture.echo can't take it in Garden: give it another alias.",
      ],
    ] as const) {
      const refused = await owner('/api/packs/garden', {
        method: 'PATCH',
        body: { name: 'plot', title: 'Plot', add: { tools: [tool] }, remove: { tools: ['fixture.shout'] } },
      })
      expect([refused.status, refused.json.detail]).toEqual([400, detail])
      const still = await owner('/api/packs/garden')
      expect([still.status, still.json.title, namesOf(still.json.tools)]).toEqual([200, 'Garden', tools])
      // Its keys would have kept `garden` leading to it had the rename run before the refusal
      expect([still.json.keys, await formerOf('garden')]).toEqual([2, [{ name: 'shed', people: 0 }]])
      expect((await owner('/api/packs/plot')).json.detail).toBe(unknown('plot'))
    }
    expect(namesOf((await owner('/api/packs')).json._embedded.packs)).toEqual(['desk', 'garden'])
  })

  it('tells the owner where it went, wherever a pack is named', async () => {
    const moved = renamed('shed', 'garden')
    for (const path of [
      '/api/packs/shed',
      '/api/packs/shed/setup',
      '/api/calls?pack=shed',
      '/api/searches?pack=shed',
      '/api/overview/stats?pack=shed',
      '/api/tools?pack=shed',
      '/api/tools/fixture.echo?pack=shed',
      '/api/playbooks/fixture-say-it-back/uses?pack=shed',
    ]) {
      const old = await owner(path)
      expect([path, old.status, old.json.detail]).toEqual([path, 404, moved])
      const never = await owner(path.replace('shed', 'nope'))
      expect([path, never.status, never.json.detail]).toEqual([path, 404, unknown('nope')])
    }
    const changed = await owner('/api/packs/shed', { method: 'PATCH', body: { title: 'Shed' } })
    expect([changed.status, changed.json.detail]).toEqual([404, moved])
    const made = await owner('/api/clients', { method: 'POST', body: { name: 'late', pack: 'shed' } })
    expect([made.status, made.json.detail]).toEqual([400, moved])
    const never = await owner('/api/clients', { method: 'POST', body: { name: 'late', pack: 'nope' } })
    expect([never.status, never.json.detail]).toEqual([400, unknown('nope')])
    // One sentence per name that is not there
    const repacked = await owner(`/api/clients/${both.id}`, {
      method: 'PATCH',
      body: { packs: ['shed', 'desk', 'nope'] },
    })
    expect([repacked.status, repacked.json.detail]).toEqual([400, `${moved} ${unknown('nope')}`])
    // Looking as a client in a pack: the old name is not one it opens, and the owner is told why
    const looked = await owner(`/api/tools?as=${sam.id}&pack=shed`)
    expect([looked.status, looked.json.detail]).toEqual([404, moved])
    const nowhere = await owner(`/api/tools?as=${sam.id}&pack=nope`)
    expect([nowhere.status, nowhere.json.detail]).toEqual([
      409,
      `The client Sam doesn't open the pack nope. It opens garden: look as it in one of those from the root, GET /api/tools?as=${sam.id}&pack=<name>.`,
    ])
    // A key is told nothing of the kind: these are the owner's routes
    const asked = await at(sam.key, '/api/packs/shed')
    expect(asked.status).toBe(403)
    expect(JSON.stringify(asked.json)).not.toContain('garden')
  })

  it('takes a name off the list when the pack goes back to it', async () => {
    await packOf('yard', 'Yard')
    const reader = await keyFor({ name: 'Sam in the yard', pack: 'yard' })
    expect(await rename('yard', 'lawn').then((moved) => moved.json.formerNames)).toEqual([
      expect.objectContaining({ name: 'yard' }),
    ])
    expect((await at(reader.key, '/p/yard/api/me')).json.pack.name).toBe('lawn')
    expect(await formerOf('lawn')).toEqual([{ name: 'yard', people: 1 }])
    expect((await rename('lawn', 'yard')).status).toBe(200)
    expect(await formerOf('yard')).toEqual([{ name: 'lawn', people: 0 }])
    // Whoever came by it is at the pack's address again: nothing is left noting them at an old one
    expect(await db.all(sql`select came_by from client_packs where client_id = ${reader.id}`)).toEqual([[null]])
    // Every name it had leads to it, newest first
    expect((await rename('yard', 'meadow')).status).toBe(200)
    expect(await formerOf('meadow')).toEqual([
      { name: 'yard', people: 0 },
      { name: 'lawn', people: 0 },
    ])
  })

  it('frees an old name when the owner says so, for another pack to take', async () => {
    const missing = await owner('/api/packs/meadow/names/plot', { method: 'DELETE' })
    expect([missing.status, missing.json.detail]).toEqual([
      404,
      'Yard has no old name plot. GET /api/packs/meadow lists them.',
    ])
    // Another pack's old name is not this one's to free
    expect((await owner('/api/packs/meadow/names/shed', { method: 'DELETE' })).status).toBe(404)
    expect((await at(sam.key, '/api/packs/meadow/names/lawn', { method: 'DELETE' })).status).toBe(403)
    expect((await owner('/api/packs/meadow/names/lawn', { method: 'DELETE' })).status).toBe(204)
    const again = await owner('/api/packs/meadow/names/lawn', { method: 'DELETE' })
    expect([again.status, again.json.detail]).toEqual([
      404,
      'Yard has no old name lawn. GET /api/packs/meadow lists them.',
    ])
    expect(await formerOf('meadow')).toEqual([{ name: 'yard', people: 0 }])
    expect((await owner('/api/packs', { method: 'POST', body: { name: 'lawn', title: 'Lawn' } })).status).toBe(201)
    expect((await owner('/api/packs', { method: 'POST', body: { name: 'yard', title: 'Yard' } })).status).toBe(409)
  })

  it('keeps none for a pack nobody has a key to, or only revoked ones', async () => {
    await packOf('bare', 'Bare')
    expect((await rename('bare', 'bald')).json.formerNames).toEqual([])
    expect((await owner('/api/packs/bare')).json.detail).toBe(unknown('bare'))
    const gone = await keyFor({ name: 'Ada, once', pack: 'bald' })
    expect((await owner(`/api/clients/${gone.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await rename('bald', 'bare')).json.formerNames).toEqual([])
    // So the name is free at once
    expect((await owner('/api/packs', { method: 'POST', body: { name: 'bald', title: 'Bald' } })).status).toBe(201)
  })

  it('frees a pack’s old names when the pack is removed', async () => {
    await packOf('hut', 'Hut')
    const reader = await keyFor({ name: 'Sam in the hut', pack: 'hut' })
    expect((await rename('hut', 'cabin')).json.formerNames).toEqual([expect.objectContaining({ name: 'hut' })])
    expect((await owner(`/api/clients/${reader.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await owner('/api/packs/cabin', { method: 'DELETE' })).status).toBe(204)
    expect((await owner('/api/packs/hut')).json.detail).toBe(unknown('hut'))
    expect((await owner('/api/packs', { method: 'POST', body: { name: 'hut', title: 'Hut' } })).status).toBe(201)
    expect((await owner('/api/packs/hut')).json.formerNames).toEqual([])
  })
})

describe('the old address of a renamed pack', () => {
  const PAGES = ['', '/docs', '/llms.txt', '/openapi.json']
  let ada: Made
  let plain: Made
  beforeAll(async () => {
    ada = await keyFor({ name: 'Ada', pack: 'desk' })
    plain = await keyFor({ name: 'a script', upstreams: 'all' })
  })
  /** Ends a key a moment ago, as time would; answers the day it ended, as the refusals print it. */
  const end = async (id: string) => {
    const time = new Date(Date.now() - 1000).toISOString()
    await db.run(sql`update clients set expires_at = ${time} where id = ${id}`)
    return dayOf(time)
  }

  it('is not where its keys are sent: the new name is served at its address, plain REST and plain /mcp', async () => {
    for (const path of ['/p/garden/api/me', '/api/me'])
      expect([path, (await at(sam.key, path)).json.pack]).toEqual([
        path,
        expect.objectContaining({ name: 'garden', title: 'Garden' }),
      ])
    expect((await at(sam.key, '/api/me')).json.packs).toEqual([
      expect.objectContaining({ name: 'garden', mcpUrl: 'http://localhost/p/garden/mcp' }),
    ])
    const client = await mcp(sam.key)
    expect(client.getServerVersion()?.name).toBe('garden')
    await client.close()
    expect(await formerOf('garden')).toEqual([{ name: 'shed', people: 0 }])
  })

  it('keeps answering REST, as the pack it is now', async () => {
    const me = await at(sam.key, '/p/shed/api/me')
    expect([me.status, me.json.pack.name]).toEqual([200, 'garden'])
    const ran = await at(sam.key, '/p/shed/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.echo', arguments: { text: 'still here' } },
    })
    expect([ran.status, ran.json.result.content[0].text]).toEqual([200, 'still here'])
    const byHeader = await at(sam.key, '/api/me', { headers: { 'x-gateway-pack': 'shed' } })
    expect([byHeader.status, byHeader.json.pack.name]).toEqual([200, 'garden'])
    // What it links to is the address the pack has now
    const home = await at(sam.key, '/p/shed/api')
    expect(home.json.name).toBe('Garden')
    expect(new URL(home.json._links.tools.href).pathname).toBe('/p/garden/api/tools')
    expect(new URL((await at(sam.key, '/p/shed/api/tools')).json._links.self.href).pathname).toBe('/p/garden/api/tools')
    // A key that opens it among others is served it there too
    expect((await at(both.key, '/p/shed/api/me')).json.pack.name).toBe('garden')
  })

  it('and MCP, in place: no client has to follow a redirect', async () => {
    for (const path of ['/p/shed/mcp', '/mcp/p/shed']) {
      const door = await knock(sam.key, path)
      expect([path, door.status, door.headers.get('location')]).toEqual([path, 200, null])
      const client = await mcp(sam.key, path)
      expect([path, client.getServerVersion()?.name]).toEqual([path, 'garden'])
      expect(namesOf((await client.listTools()).tools)).toEqual(
        expect.arrayContaining(['fixture.echo', 'fixture.shout']),
      )
      const shouted = await client.callTool({ name: 'fixture.shout', arguments: { text: 'by the old door' } })
      expect((shouted.content as { text: string }[])[0]?.text).toBe('BY THE OLD DOOR')
      await client.close()
    }
    const byHeader = await mcp(sam.key, '/mcp', { 'x-gateway-pack': 'shed' })
    expect(byHeader.getServerVersion()?.name).toBe('garden')
    expect(namesOf((await byHeader.listTools()).tools)).toContain('fixture.echo')
    await byHeader.close()
  })

  it('sends a reader of its pages on to the same page at the new address', async () => {
    for (const page of PAGES) {
      const sent = await at(sam.key, `/p/shed${page}`)
      expect([page, sent.status, sent.headers.get('location')]).toEqual([page, 308, `/p/garden${page}`])
      expect(sent.headers.get('cache-control')).toBe('private, no-cache')
    }
    const asked = await at(sam.key, '/p/shed/docs?theme=dark&layout=classic')
    expect([asked.status, asked.headers.get('location')]).toEqual([308, '/p/garden/docs?theme=dark&layout=classic'])
    expect((await at(sam.key, '/p/shed/')).headers.get('location')).toBe('/p/garden/')
    // The owner, too
    expect((await owner('/p/shed/llms.txt')).headers.get('location')).toBe('/p/garden/llms.txt')
    // Where it sends them answers, under the name the pack has now
    const guide = await app.request('/p/garden/llms.txt', { headers: { authorization: `Bearer ${sam.key}` } })
    expect([guide.status, (await guide.text()).includes('http://localhost/p/garden/mcp')]).toEqual([200, true])
    // Without credentials an old name is any name
    for (const page of PAGES) {
      const old = await at(null, `/p/shed${page}`)
      const none = await at(null, `/p/nope${page}`)
      expect([page, old.status, old.json?.detail, old.headers.get('location')]).toEqual([
        page,
        401,
        none.json?.detail,
        null,
      ])
    }
  })

  it('tells a key that does not open the pack nothing', async () => {
    for (const stranger of [ada, plain]) {
      const never = (await at(stranger.key, '/p/nope/api/me')).json.detail as string
      const told = never.replaceAll('nope', 'shed')
      const answers = [
        await at(stranger.key, '/p/shed/api/me'),
        await at(stranger.key, '/api/me', { headers: { 'x-gateway-pack': 'shed' } }),
        await at(stranger.key, '/p/shed/api/calls', {
          method: 'POST',
          body: { tool: 'fixture.echo', arguments: { text: 'hello' } },
        }),
        await knock(stranger.key, '/p/shed/mcp'),
        await knock(stranger.key, '/mcp/p/shed'),
        await knock(stranger.key, '/mcp', { 'x-gateway-pack': 'shed' }),
        ...(await Promise.all(PAGES.map((page) => at(stranger.key, `/p/shed${page}`)))),
      ]
      expect(answers).toHaveLength(10)
      for (const answer of answers) {
        expect([answer.status, answer.json?.detail, answer.headers.get('location')]).toEqual([403, told, null])
        expect(JSON.stringify(answer.json).toLowerCase()).not.toContain('garden')
      }
    }
    // What each is told, in full: the name it asked for and the packs it does open
    expect((await at(ada.key, '/p/shed/api/me')).json.detail).toBe(
      "This key doesn't open the pack shed. It opens desk (/p/desk/mcp).",
    )
    expect((await at(plain.key, '/p/shed/api/me')).json.detail).toBe(
      "This key isn't locked to packs: connect to /mcp, which serves everything it may reach.",
    )
  })

  it('answers the owner as the pack', async () => {
    const home = await owner('/p/shed/api')
    expect([home.status, home.json.name]).toEqual([200, 'Garden'])
    expect((await owner('/p/shed/api/me')).json).toMatchObject({ owner: false, pack: { name: 'garden' } })
    const managing = await owner('/p/shed/api/packs')
    expect([managing.status, managing.json.detail]).toEqual([
      403,
      'This request is for the pack garden only: manage the gateway at /api or in /app, without a pack.',
    ])
    expect((await owner('/p/nope/api/me')).json.detail).toBe(unknown('nope'))
    // `pack` may say the name the address was asked by, or the one it has now: both are this pack
    const byNow = await owner('/p/shed/api/tools?pack=garden')
    expect([byNow.status, namesOf(byNow.json._embedded.tools)]).toEqual([200, ['fixture.echo', 'fixture.shout']])
    for (const query of ['pack=shed', `as=${sam.id}&pack=shed`]) {
      const byOld = await owner(`/p/shed/api/tools?${query}`)
      expect([query, byOld.status, byOld.json._embedded]).toEqual([query, 200, byNow.json._embedded])
    }
    const other = await owner('/p/shed/api/tools?pack=desk')
    expect([other.status, other.json.detail]).toEqual([
      400,
      'This request is for the pack garden: look at desk from the root, GET /api/tools?pack=desk.',
    ])
  })

  it('notes who still comes by it, until they come by the new one', async () => {
    for (const key of [sam.key, both.key]) expect((await at(key, '/p/garden/api/me')).status).toBe(200)
    expect(await formerOf('garden')).toEqual([{ name: 'shed', people: 0 }])
    expect((await at(sam.key, '/p/shed/api/me')).status).toBe(200)
    expect(await formerOf('garden')).toEqual([{ name: 'shed', people: 1 }])
    // Plain REST names no address, so it says nothing of which one the app is set up with
    expect((await at(sam.key, '/api/me')).status).toBe(200)
    expect(await formerOf('garden')).toEqual([{ name: 'shed', people: 1 }])
    const client = await mcp(both.key, '/mcp/p/shed')
    await client.listTools()
    await client.close()
    expect(await formerOf('garden')).toEqual([{ name: 'shed', people: 2 }])
    expect((await at(sam.key, '/p/garden/api/me')).status).toBe(200)
    expect(await formerOf('garden')).toEqual([{ name: 'shed', people: 1 }])
    // The owner looking as a key is not that key coming by, and a key that is refused there never came
    expect((await owner(`/p/shed/api/tools?as=${sam.id}`)).status).toBe(200)
    expect((await at(ada.key, '/p/shed/api/me')).status).toBe(403)
    expect(await formerOf('garden')).toEqual([{ name: 'shed', people: 1 }])
  })

  it('writes the note once, then at most hourly, however busy the key', async () => {
    /** The note on the key's link to the pack, as stored: the name it came by and when. */
    const noted = async () =>
      (await db.all(
        sql`select came_by, came_by_at from client_packs where client_id = ${both.id} and came_by is not null`,
      )) as [string, string][]
    const first = await noted()
    expect(first).toEqual([['shed', expect.any(String)]])
    expect((await at(both.key, '/p/shed/api/tools')).status).toBe(200)
    expect(await noted()).toEqual(first)
    const before = new Date(Date.now() - 2 * 3_600_000).toISOString()
    await db.run(sql`update client_packs set came_by_at = ${before} where client_id = ${both.id} and came_by = 'shed'`)
    expect((await at(both.key, '/p/shed/api/tools')).status).toBe(200)
    expect(Date.parse((await noted())[0]?.[1] ?? '')).toBeGreaterThan(Date.now() - 60_000)
  })

  it('keeps what was noted when a key’s packs change', async () => {
    const changed = await owner(`/api/clients/${both.id}`, {
      method: 'PATCH',
      body: { packs: ['desk', 'garden'], pack: 'desk' },
    })
    expect([changed.status, changed.json.pack, changed.json.packs]).toEqual([200, 'desk', ['desk', 'garden']])
    expect(await formerOf('garden')).toEqual([{ name: 'shed', people: 1 }])
    expect((await at(both.key, '/api/me')).json.pack.name).toBe('desk')
    expect((await at(both.key, '/p/shed/api/me')).json.pack.name).toBe('garden')
    // A pack it no longer opens is forgotten with its note
    const narrowed = await owner(`/api/clients/${both.id}`, { method: 'PATCH', body: { packs: ['desk'] } })
    expect(narrowed.json.packs).toEqual(['desk'])
    expect(await formerOf('garden')).toEqual([{ name: 'shed', people: 0 }])
    expect((await at(both.key, '/p/shed/api/me')).json.detail).toBe(
      "This key doesn't open the pack shed. It opens desk (/p/desk/mcp).",
    )
  })

  it('is kept for a pack whose only key has ended: Extend brings it back', async () => {
    await packOf('pond', 'Pond')
    const reader = await keyFor({ name: 'Ada at the pond', pack: 'pond', expiresIn: '7d' })
    const day = await end(reader.id)
    expect((await rename('pond', 'lake')).json).toMatchObject({ keys: 0, formerNames: [{ name: 'pond', people: 0 }] })
    const ended = `Your access to Pond ended on ${day}. Ask the owner for a new invite.`
    const refused = await at(reader.key, '/p/pond/api/me')
    expect([refused.status, refused.json.detail]).toEqual([403, ended])
    // Over MCP it still connects there, to be told why
    const client = await mcp(reader.key, '/p/pond/mcp')
    expect(client.getInstructions()).toBe(ended)
    await client.close()
    // An ended key is not one of its people, here or by any name
    expect(await formerOf('lake')).toEqual([{ name: 'pond', people: 0 }])
    const extended = await owner(`/api/clients/${reader.id}`, { method: 'PATCH', body: { expiresIn: '7d' } })
    expect(extended.status).toBe(200)
    const back = await at(reader.key, '/p/pond/api/me')
    expect([back.status, back.json.pack.name]).toEqual([200, 'lake'])
    expect(await formerOf('lake')).toEqual([{ name: 'pond', people: 1 }])
  })

  it('stops answering once the owner frees the name, also when another pack takes it', async () => {
    expect((await at(sam.key, '/p/shed/api/me')).status).toBe(200)
    expect(await formerOf('garden')).toEqual([{ name: 'shed', people: 1 }])
    expect((await owner('/api/packs/garden/names/shed', { method: 'DELETE' })).status).toBe(204)
    expect(await formerOf('garden')).toEqual([])
    expect((await owner('/api/packs/shed')).json.detail).toBe(unknown('shed'))
    const refusal = "This key doesn't open the pack shed. It opens garden (/p/garden/mcp)."
    const before = await at(sam.key, '/p/shed/api/me')
    expect([before.status, before.json.detail]).toEqual([403, refusal])
    await packOf('shed', 'Shed')
    const after = await at(sam.key, '/p/shed/api/me')
    expect([after.status, after.json.detail]).toEqual([403, refusal])
    expect((await knock(sam.key, '/p/shed/mcp')).status).toBe(403)
    expect((await at(sam.key, '/p/shed/docs')).status).toBe(403)
    expect((await at(sam.key, '/p/garden/api/me')).status).toBe(200)
    // The name is that pack's own now: taking it back is refused as any taken name
    expect((await rename('garden', 'shed')).json.detail).toBe('A pack is already named shed: pick another name.')
  })
})

describe('two renames at once', () => {
  const formerRows = async (name: string) =>
    (await db.all(sql`select name from pack_names where name = ${name}`)) as unknown[]
  const paired = async (first: string, second: string) => {
    for (const name of [first, second]) {
      await packOf(name, name)
      await keyFor({ name: `Sam of ${name}`, pack: name })
    }
  }

  it('gives the name to one and tells the other it is taken, leaving its own name as it was', async () => {
    await paired('north', 'south')
    const answers = await Promise.all([rename('north', 'pole'), rename('south', 'pole')])
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409])
    const lost = answers[0]?.status === 409 ? 'north' : 'south'
    expect(answers.find((answer) => answer.status === 409)?.json.detail).toBe(
      'A pack is already named pole: pick another name.',
    )
    expect(await formerOf(lost)).toEqual([])
    expect(await formerRows(lost)).toEqual([])
    expect((await owner(`/p/${lost}/docs`)).status).toBe(200)
    expect((await rename(lost, `${lost}-again`)).status).toBe(200)
  })

  it('tells a rename it lost to a new pack of that name', async () => {
    await paired('east', 'west')
    const [renamed, made] = await Promise.all([
      rename('east', 'dawn'),
      owner('/api/packs', { method: 'POST', body: { name: 'dawn', title: 'Dawn' } }),
    ])
    // Whichever wrote first has the name, the other a 409: the rename is never left half done
    const won = renamed.status === 200
    expect([renamed.status, made.status]).toEqual(won ? [200, 409] : [409, 201])
    expect(await formerRows('east')).toHaveLength(won ? 1 : 0)
    expect((await owner('/p/east/docs')).status).toBe(won ? 308 : 200)
  })

  it('tells one of two new packs of a name that it is taken', async () => {
    const make = () => owner('/api/packs', { method: 'POST', body: { name: 'twin', title: 'Twin' } })
    const answers = await Promise.all([make(), make()])
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409])
    expect(answers.find((answer) => answer.status === 409)?.json.detail).toBe(
      'A pack is already named twin: pick another name.',
    )
  })

  it('answers the same rename sent twice with the pack both times', async () => {
    await paired('dusk', 'noon')
    const answers = await Promise.all([rename('dusk', 'night'), rename('dusk', 'night')])
    expect(answers.map((answer) => answer.status)).toEqual([200, 200])
    expect(await formerOf('night')).toEqual([{ name: 'dusk', people: 0 }])
  })

  it('undoes the name it held back when the name it asked for is taken as it writes', async () => {
    await paired('reed', 'moss')
    const [[id]] = (await db.all(sql`select id from packs where name = 'reed'`)) as [[string]]
    // The pack as a request read it, before another took the name it is about to ask for
    const read = { id, name: 'reed', title: 'reed', description: '', createdAt: '', updatedAt: '', triedAt: null }
    await expect(packsRepo(db).rename(read, 'moss', true)).rejects.toThrow()
    expect(await formerRows('reed')).toEqual([])
  })

  it('never reads the name a pack has now as one it used to have', async () => {
    const [[id]] = (await db.all(sql`select id from packs where name = 'moss'`)) as [[string]]
    // What a lost race left behind before it was undone
    await db.run(sql`insert into pack_names (name, pack_id, until) values ('moss', ${id}, ${new Date().toISOString()})`)
    for (const page of ['/docs', '/llms.txt', '/openapi.json'])
      expect([page, (await owner(`/p/moss${page}`)).status]).toEqual([page, 200])
    expect((await rename('moss', 'fern')).status).toBe(200)
    expect(await formerOf('fern')).toEqual([{ name: 'moss', people: 0 }])
  })
})
