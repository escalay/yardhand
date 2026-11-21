/**
 * A pack's inputs. Each input of a pack tool is Fixed (hidden, filled on every call), a Default (shown with the
 * pack's value, which the agent may replace) or left to the agent, and a value may write one of the pack's variables
 * as `{{name}}`. A value that stops fitting its tool is flagged, and a flag never blocks a change that leaves it alone.
 */
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-pack-inputs'
const upstream = await startUpstream({ token: 'fixture-token', greeting: true })
const app = await createApp({
  db: await testDb(),
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
/** What a tool answers over MCP, as the agent reads it. */
const said = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  ((await client.callTool({ name, arguments: args })).content as { text?: string }[])
    .map((block) => block.text ?? '')
    .join('\n')
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
  return made.json as { id: string; key: string }
}
/** What `greet` answers a key over REST. */
const greeted = async (key: string, tool: string, args: Record<string, unknown>) => {
  const ran = await api(key, '/api/calls', { method: 'POST', body: { tool, arguments: args } })
  return ran.status === 200 ? (ran.json.result.content[0].text as string) : ran
}
/** The fixture changes `greet`, and the owner approves the change: its upstream is reviewed. */
const greetTakes = async (from: true | false | 'enum') => {
  upstream.state.greetFrom = from
  await owner('/api/upstreams/fixture/sync', { method: 'POST' })
  const pending = (await owner('/api/reviews')).json._embedded.reviews.find(
    (review: { name: string }) => review.name === 'fixture.greet',
  )
  if (pending) await owner(`/api/reviews/${pending.versionId}`, { method: 'POST', body: { decision: 'approve' } })
}
const packWith = async (name: string, title: string, tools: Record<string, unknown>[]) => {
  await owner('/api/packs', { method: 'POST', body: { name, title, description: `${title}: greets people.` } })
  const added = await owner(`/api/packs/${name}`, { method: 'PATCH', body: { add: { tools } } })
  expect([name, added.status, added.json?.detail]).toEqual([name, 200, undefined])
  return added.json
}
const toolOf = (pack: { tools: { name: string }[] }, name: string) =>
  pack.tools.find((tool) => tool.name === name) as any
const inputOf = (tool: { inputs: { name: string }[] }, name: string) =>
  tool.inputs.find((input) => input.name === name) as any
/** The body schema of one tool in the OpenAPI document a key reads. */
const openApiBodyOf = async (key: string, tool: string) =>
  (await api(key, '/api/tools/openapi.json')).json.paths[`/api/tools/${tool}/calls`].post.requestBody.content[
    'application/json'
  ].schema

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

describe('the three modes of an input', () => {
  let desk = ''
  let client: Client
  beforeAll(async () => {
    await packWith('desk', 'Front desk', [
      { name: 'fixture.greet', alias: 'greet_fixed', fixed: { from: 'the desk' } },
      { name: 'fixture.greet', alias: 'greet_default', defaults: { from: 'the desk' } },
      { name: 'fixture.greet' },
    ])
    desk = (await keyFor({ name: 'desk-agent', pack: 'desk' })).key
    client = await mcp(desk)
  })
  afterAll(() => client.close())

  it('tells the owner the mode of every input, in the tool’s own order', async () => {
    const pack = (await owner('/api/packs/desk')).json
    expect(pack.variables).toEqual([])
    expect(pack.findings).toEqual([])
    expect(pack.tools.map((tool: { name: string; inputs: unknown[] }) => [tool.name, tool.inputs])).toEqual([
      [
        'greet_fixed',
        [
          { name: 'to', mode: 'agent', value: null, resolved: null, required: true, problem: null, note: null },
          {
            name: 'from',
            mode: 'fixed',
            value: 'the desk',
            resolved: 'the desk',
            required: true,
            problem: null,
            note: null,
          },
        ],
      ],
      [
        'greet_default',
        [
          expect.objectContaining({ name: 'to', mode: 'agent' }),
          expect.objectContaining({ name: 'from', mode: 'default', value: 'the desk', resolved: 'the desk' }),
        ],
      ],
      [
        'fixture.greet',
        [
          expect.objectContaining({ name: 'to', mode: 'agent' }),
          expect.objectContaining({ name: 'from', mode: 'agent' }),
        ],
      ],
    ])
    expect(toolOf(pack, 'greet_fixed')).toMatchObject({ fixed: { from: 'the desk' }, defaults: {} })
    expect(toolOf(pack, 'greet_default')).toMatchObject({ fixed: {}, defaults: { from: 'the desk' } })
  })

  it('Fixed: hidden from the pack’s keys, sent on every call, and never theirs to send', async () => {
    for (const schema of [
      (await api(desk, '/api/tools/greet_fixed')).json.inputSchema,
      await openApiBodyOf(desk, 'greet_fixed'),
      (await client.listTools()).tools.find((tool) => tool.name === 'greet_fixed')?.inputSchema,
    ]) {
      expect(Object.keys(schema.properties)).toEqual(['to'])
      expect(schema.required).toEqual(['to'])
    }
    expect(await said(client, 'describe_tool', { name: 'greet_fixed' })).not.toContain('"from"')

    expect(await greeted(desk, 'greet_fixed', { to: 'Sam' })).toBe('Hello Sam, from the desk')
    const named = await api(desk, '/api/tools/greet_fixed/calls', { method: 'POST', body: { to: 'Ada' } })
    expect(named.json.result.content[0].text).toBe('Hello Ada, from the desk')
    expect(await said(client, 'greet_fixed', { to: 'Sam' })).toBe('Hello Sam, from the desk')
    expect(await said(client, 'call_tool', { name: 'greet_fixed', arguments: { to: 'Ada' } })).toBe(
      'Hello Ada, from the desk',
    )

    const forged = await api(desk, '/api/calls', {
      method: 'POST',
      body: { tool: 'greet_fixed', arguments: { to: 'Sam', from: 'someone else' } },
    })
    expect(forged.status).toBe(400)
    expect(forged.json.detail).toBe('greet_fixed: Front desk fills from itself, so leave it out.')
    expect(await said(client, 'call_tool', { name: 'greet_fixed', arguments: { to: 'Sam', from: 'me' } })).toContain(
      'fills from itself',
    )
  })

  it('Default: shown with the pack’s value, sent when the agent leaves it out, and the agent’s own value wins', async () => {
    for (const schema of [
      (await api(desk, '/api/tools/greet_default')).json.inputSchema,
      (await api(desk, '/api/me')).json.pins.find((pin: { name: string }) => pin.name === 'greet_default').inputSchema,
      await openApiBodyOf(desk, 'greet_default'),
      (await client.listTools()).tools.find((tool) => tool.name === 'greet_default')?.inputSchema,
    ]) {
      expect(schema.properties.from).toEqual({ type: 'string', default: 'the desk' })
      expect(schema.required).toEqual(['to'])
    }
    expect(await said(client, 'describe_tool', { name: 'greet_default' })).toContain(
      '"from":{"type":"string","default":"the desk"}',
    )

    expect(await greeted(desk, 'greet_default', { to: 'Sam' })).toBe('Hello Sam, from the desk')
    expect(await greeted(desk, 'greet_default', { to: 'Sam', from: 'the boss' })).toBe('Hello Sam, from the boss')
    const named = await api(desk, '/api/tools/greet_default/calls', { method: 'POST', body: { to: 'Ada' } })
    expect(named.json.result.content[0].text).toBe('Hello Ada, from the desk')
    expect(await said(client, 'greet_default', { to: 'Sam' })).toBe('Hello Sam, from the desk')
    expect(await said(client, 'greet_default', { to: 'Sam', from: 'the boss' })).toBe('Hello Sam, from the boss')
    expect(await said(client, 'call_tool', { name: 'greet_default', arguments: { to: 'Ada' } })).toBe(
      'Hello Ada, from the desk',
    )
    expect(await said(client, 'call_tool', { name: 'greet_default', arguments: { to: 'Ada', from: 'Sam' } })).toBe(
      'Hello Ada, from Sam',
    )
    // The log keeps what the caller sent, not what the pack filled in
    const [last] = (await owner('/api/calls?tool=fixture.greet&limit=50')).json._embedded.calls.filter(
      (call: { status: string }) => call.status === 'ok',
    )
    expect((await owner(`/api/calls/${last.id}/payload`)).json.arguments).toEqual({ to: 'Ada', from: 'Sam' })
  })

  it('Agent decides: the input as the tool has it, for the agent to fill', async () => {
    for (const schema of [
      (await api(desk, '/api/tools/fixture.greet')).json.inputSchema,
      await openApiBodyOf(desk, 'fixture.greet'),
      (await client.listTools()).tools.find((tool) => tool.name === 'fixture.greet')?.inputSchema,
    ]) {
      expect(schema.properties.from).toEqual({ type: 'string' })
      expect(schema.required).toEqual(['to', 'from'])
    }
    expect(await greeted(desk, 'fixture.greet', { to: 'Sam', from: 'Ada' })).toBe('Hello Sam, from Ada')
    expect(await said(client, 'fixture.greet', { to: 'Sam', from: 'Ada' })).toBe('Hello Sam, from Ada')
    expect(await greeted(desk, 'fixture.greet', { to: 'Sam' })).toMatchObject({ status: 400 })
  })

  it('moves an input from one mode to another, and refuses it in two at once', async () => {
    const both = await owner('/api/packs/desk/tools/greet_default', {
      method: 'PATCH',
      body: { fixed: { from: 'the boss' } },
    })
    expect(both.status).toBe(400)
    expect(both.json.detail).toContain('from is both fixed and a default: keep it in one')
    expect(both.json.errors).toEqual([
      {
        in: 'body',
        path: 'tools.greet_default.defaults.from',
        message: 'from is both fixed and a default: keep it in one',
      },
    ])
    const unknown = await owner('/api/packs/desk/tools/greet_default', {
      method: 'PATCH',
      body: { defaults: { colour: 'red' } },
    })
    expect([unknown.status, unknown.json.detail]).toEqual([
      400,
      "Not saved: fixture.greet has no input colour. GET /api/tools/{name} shows each tool's inputs.",
    ])
    const wrongType = await owner('/api/packs/desk', {
      method: 'PATCH',
      body: { add: { tools: [{ name: 'fixture.greet', alias: 'greet_bad', defaults: { from: 7 } }] } },
    })
    expect([wrongType.status, wrongType.json.errors]).toEqual([
      400,
      [{ in: 'body', path: 'tools.greet_bad.defaults.from', message: 'from must be string' }],
    ])
    const moved = await owner('/api/packs/desk/tools/greet_default', {
      method: 'PATCH',
      body: { fixed: { from: 'the boss' }, defaults: null },
    })
    expect(moved.json).toMatchObject({ fixed: { from: 'the boss' }, defaults: {} })
    expect(await greeted(desk, 'greet_default', { to: 'Sam' })).toBe('Hello Sam, from the boss')
    const back = await owner('/api/packs/desk/tools/greet_default', {
      method: 'PATCH',
      body: { fixed: {}, defaults: { from: 'the desk' } },
    })
    expect(back.json).toMatchObject({ fixed: {}, defaults: { from: 'the desk' } })
  })
})

describe('a pack’s variables', () => {
  let lobby = ''
  const variables = (list: unknown[]) =>
    owner('/api/packs/lobby/variables', { method: 'PUT', body: { variables: list } })
  beforeAll(async () => {
    await packWith('lobby', 'Lobby', [{ name: 'fixture.greet', alias: 'greet_from_desk', fixed: { from: 'the desk' } }])
    lobby = (await keyFor({ name: 'lobby-agent', pack: 'lobby' })).key
  })

  it('are set as one list, and say which tools use them', async () => {
    const set = await variables([
      { name: 'desk', value: 'the desk', description: 'Who greets.' },
      { name: 'days', value: 7 },
    ])
    expect(set.status).toBe(200)
    expect(set.json.variables).toEqual([
      { name: 'desk', value: 'the desk', description: 'Who greets.', usedBy: [] },
      { name: 'days', value: 7, description: null, usedBy: [] },
    ])
    expect(set.json.findings).toEqual([
      {
        level: 'warning',
        code: 'unused_variable',
        path: 'variables.desk',
        message: 'desk is not used by any tool yet',
      },
      {
        level: 'warning',
        code: 'unused_variable',
        path: 'variables.days',
        message: 'days is not used by any tool yet',
      },
    ])
  })

  it('fill a fixed value that writes one, and a new value changes the next call', async () => {
    const used = await owner('/api/packs/lobby/tools/greet_from_desk', {
      method: 'PATCH',
      body: { fixed: { from: '{{desk}}' } },
    })
    expect(used.status).toBe(200)
    expect(used.json.fixed).toEqual({ from: '{{desk}}' })
    expect(inputOf(used.json, 'from')).toMatchObject({ mode: 'fixed', value: '{{desk}}', resolved: 'the desk' })
    expect((await owner('/api/packs/lobby')).json.variables[0]).toMatchObject({
      name: 'desk',
      usedBy: ['greet_from_desk'],
    })
    expect(await greeted(lobby, 'greet_from_desk', { to: 'Sam' })).toBe('Hello Sam, from the desk')

    expect((await variables([{ name: 'desk', value: 'the boss' }])).status).toBe(200)
    expect(await greeted(lobby, 'greet_from_desk', { to: 'Sam' })).toBe('Hello Sam, from the boss')
    // A pack key never reads what its pack fills in
    expect(JSON.stringify((await api(lobby, '/api/tools/greet_from_desk')).json)).not.toContain('the boss')
  })

  it('cannot be removed while a value still writes one', async () => {
    const removed = await variables([])
    expect(removed.status).toBe(400)
    expect(removed.json.detail).toBe(
      'Not saved: {{desk}} is still used by greet_from_desk (from): change that first, or keep the variable.',
    )
    expect(removed.json.errors).toEqual([
      {
        in: 'body',
        path: 'variables.desk',
        message: '{{desk}} is still used by greet_from_desk (from): change that first, or keep the variable.',
      },
    ])
    expect((await owner('/api/packs/lobby')).json.variables.map((variable: { name: string }) => variable.name)).toEqual(
      ['desk'],
    )
  })

  it('need a name of their own, written as a variable is', async () => {
    const bad = await variables([
      { name: 'Desk Name', value: 'the desk' },
      { name: 'desk', value: 'the desk' },
    ])
    expect(bad.status).toBe(400)
    expect(bad.json.detail).toContain('Desk Name is not a variable name')
    const twice = await variables([
      { name: 'desk', value: 'the desk' },
      { name: 'desk', value: 'the boss' },
    ])
    expect(twice.status).toBe(400)
    expect(twice.json.detail).toContain('desk is declared twice: keep one')
    expect((await variables([{ name: 'desk' }])).status).toBe(400)
    expect(await greeted(lobby, 'greet_from_desk', { to: 'Sam' })).toBe('Hello Sam, from the boss')
  })

  it('leave a word that is no variable of the pack exactly as written, with a note', async () => {
    const saved = await owner('/api/packs/lobby/tools/greet_from_desk', {
      method: 'PATCH',
      body: { fixed: { from: '{{first_name}} at {{desk}}' } },
    })
    expect(saved.status).toBe(200)
    expect(inputOf(saved.json, 'from')).toMatchObject({
      value: '{{first_name}} at {{desk}}',
      resolved: '{{first_name}} at the boss',
      problem: null,
      note: 'no variable first_name: sent as written',
    })
    const pack = (await owner('/api/packs/lobby')).json
    expect(pack.findings).toEqual([
      {
        level: 'warning',
        code: 'not_a_variable',
        path: 'tools.greet_from_desk.fixed.from',
        message: 'no variable first_name: sent as written',
      },
    ])
    // A note is not a flag
    expect(pack.flags).toBe(0)
    expect(await greeted(lobby, 'greet_from_desk', { to: 'Sam' })).toBe('Hello Sam, from {{first_name}} at the boss')
  })

  it('are the owner’s to set, and never from inside a pack', async () => {
    const body = { variables: [{ name: 'desk', value: 'the desk' }] }
    const asKey = await api(lobby, '/api/packs/lobby/variables', { method: 'PUT', body })
    expect([asKey.status, asKey.json.detail]).toEqual([
      403,
      'Only the owner manages the gateway: use an owner key or /app.',
    ])
    const inside = await owner('/p/lobby/api/packs/lobby/variables', { method: 'PUT', body })
    expect(inside.status).toBe(403)
    expect(inside.json.detail).toContain('This request is for the pack lobby only')
    expect((await owner('/api/packs/nope/variables', { method: 'PUT', body })).status).toBe(404)
  })
})

describe('a flag never blocks a change that leaves it alone', () => {
  afterAll(() => greetTakes(true))

  it('lets every other change through while one stands', async () => {
    await packWith('twins', 'Twins', [
      { name: 'fixture.greet', alias: 'greet_one', fixed: { from: 'one' } },
      { name: 'fixture.greet', alias: 'greet_two', fixed: { from: 'two' } },
    ])
    await greetTakes(false)
    expect((await owner('/api/packs/twins')).json.flags).toBe(2)

    const one = await owner('/api/packs/twins/tools/greet_one', { method: 'PATCH', body: { fixed: { sender: 'one' } } })
    expect([one.status, one.json.lostInputs]).toEqual([200, []])
    expect((await owner('/api/packs/twins')).json.flags).toBe(1)

    const set = await owner('/api/packs/twins/variables', {
      method: 'PUT',
      body: { variables: [{ name: 'desk', value: 'the desk' }] },
    })
    expect(set.status).toBe(200)
    const added = await owner('/api/packs/twins', {
      method: 'PATCH',
      body: { add: { tools: [{ name: 'fixture.echo' }] } },
    })
    expect([added.status, added.json.counts.tools]).toEqual([200, 3])
    // Adding a name the pack already has changes nothing, so its flag is not the request's to answer for
    const again = await owner('/api/packs/twins', {
      method: 'PATCH',
      body: { add: { tools: [{ name: 'fixture.greet', alias: 'greet_two', fixed: { from: 'two' } }] } },
    })
    expect([again.status, again.json.counts.tools]).toEqual([200, 3])
    const renamed = await owner('/api/packs/twins/tools/greet_two', {
      method: 'PATCH',
      body: { alias: 'greet_second' },
    })
    expect([renamed.status, renamed.json.name, renamed.json.lostInputs]).toEqual([200, 'greet_second', ['from']])

    // Sending the flagged value again is the request's own, and is refused
    const same = await owner('/api/packs/twins/tools/greet_second', {
      method: 'PATCH',
      body: { fixed: { from: 'two' } },
    })
    expect([same.status, same.json.detail]).toEqual([
      400,
      "Not saved: fixture.greet has no input from. GET /api/tools/{name} shows each tool's inputs.",
    ])
    const two = await owner('/api/packs/twins/tools/greet_second', {
      method: 'PATCH',
      body: { fixed: { sender: 'two' } },
    })
    expect(two.status).toBe(200)
    expect((await owner('/api/packs/twins')).json.flags).toBe(0)
    expect((await owner('/api/packs/twins', { method: 'DELETE' })).status).toBe(204)
  })
})
