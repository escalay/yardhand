/**
 * A pack's inputs. Each input of a pack tool is Fixed (hidden, filled on every call), a Default (shown with the
 * pack's value, which the agent may replace), Per person (hidden, filled with each person's own value) or left to the
 * agent, and a value may write one of the pack's variables as `{{name}}`. A value that stops fitting its tool is
 * flagged, and a flag never blocks a change that leaves it alone.
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
const greetTakes = async (from: true | false | 'enum' | 'ref' | 'optional') => {
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

  it('tells the pack’s keys, in the pack’s own guide, how the inputs it sets read to them', async () => {
    const guide = await app.request('/p/desk/llms.txt', { headers: { authorization: `Bearer ${desk}` } })
    const text = (await guide.text()).replace(/\s+/g, ' ')
    expect(text).toContain("An input the pack fills itself is not in the tool's schema")
    expect(text).toContain('An input the pack gives a default shows that default in the schema')
  })

  it('tells the owner the mode of every input, in the tool’s own order', async () => {
    const pack = (await owner('/api/packs/desk')).json
    expect(pack.variables).toEqual([])
    expect(pack.findings).toEqual([])
    expect(pack.tools.map((tool: { name: string; inputs: unknown[] }) => [tool.name, tool.inputs])).toEqual([
      [
        'greet_fixed',
        [
          {
            name: 'to',
            mode: 'agent',
            value: null,
            resolved: null,
            required: true,
            problem: null,
            note: null,
            unchecked: false,
          },
          {
            name: 'from',
            mode: 'fixed',
            value: 'the desk',
            resolved: 'the desk',
            required: true,
            problem: null,
            note: null,
            unchecked: false,
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
      'Not saved: greet_default: fixture.greet has no input colour. GET /api/tools/fixture.greet shows its inputs.',
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

describe('a pack shared with a person', () => {
  const SECRET = 'the back office'
  let porch: { id: string; key: string; message: string }
  beforeAll(async () => {
    await packWith('porch', 'Porch', [
      { name: 'fixture.greet', alias: 'greet_fixed', fixed: { from: '{{sender}}' } },
      { name: 'fixture.greet', alias: 'greet_default', defaults: { from: 'the porch' } },
    ])
    const set = await owner('/api/packs/porch/variables', {
      method: 'PUT',
      body: { variables: [{ name: 'sender', value: SECRET }] },
    })
    expect(set.status).toBe(200)
    const made = await owner('/api/packs/porch/people', { method: 'POST', body: { name: 'Sam', app: 'claude-code' } })
    expect(made.status).toBe(201)
    porch = made.json
  })

  it('never shows a fixed value in the share’s answer, its message or the People list', async () => {
    for (const shown of [JSON.stringify(porch), JSON.stringify((await owner('/api/packs/porch/people')).json)]) {
      expect(shown).not.toContain(SECRET)
      expect(shown).not.toContain('{{sender}}')
    }
    expect(porch.message).toContain(porch.key)
  })

  it('gives the person’s key the pack’s fixed and default inputs, as any key of the pack', async () => {
    const fixed = (await api(porch.key, '/p/porch/api/tools/greet_fixed')).json.inputSchema
    expect(Object.keys(fixed.properties)).toEqual(['to'])
    const defaulted = (await api(porch.key, '/p/porch/api/tools/greet_default')).json.inputSchema
    expect(defaulted.properties.from).toEqual({ type: 'string', default: 'the porch' })
    expect(await greeted(porch.key, 'greet_fixed', { to: 'Ada' })).toBe(`Hello Ada, from ${SECRET}`)
    expect(await greeted(porch.key, 'greet_default', { to: 'Ada' })).toBe('Hello Ada, from the porch')
    const forged = await api(porch.key, '/api/calls', {
      method: 'POST',
      body: { tool: 'greet_fixed', arguments: { to: 'Ada', from: 'someone else' } },
    })
    expect([forged.status, forged.json.detail]).toEqual([400, 'greet_fixed: Porch fills from itself, so leave it out.'])
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
      { name: 'desk', value: 'the desk', description: 'Who greets.', perPerson: false, usedBy: [] },
      { name: 'days', value: 7, description: null, perPerson: false, usedBy: [] },
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

  it('stay filled in for every call that arrives while they are being saved', async () => {
    const set = await owner('/api/packs/lobby/tools/greet_from_desk', {
      method: 'PATCH',
      body: { fixed: {}, defaults: { from: '{{desk}}' } },
    })
    expect(set.status).toBe(200)
    // Each read starts a few turns of the loop later than the one before, so some land inside the save
    const later = async <T>(turns: number, ask: () => Promise<T>) => {
      for (let turn = 0; turn < turns; turn++) await Promise.resolve()
      return ask()
    }
    const [saved, ...read] = await Promise.all([
      variables([{ name: 'desk', value: 'the boss' }]).then((answer) => answer.status),
      ...Array.from({ length: 200 }, (_, turns) =>
        later(turns, async () => {
          const shown = await api(lobby, '/api/tools/greet_from_desk')
          return shown.json.inputSchema.properties.from.default as string
        }),
      ),
    ])
    expect(saved).toBe(200)
    expect([...new Set(read)]).toEqual(['the boss'])
    const [, ...said] = await Promise.all([
      variables([{ name: 'desk', value: 'the boss' }]),
      ...Array.from({ length: 40 }, (_, turns) =>
        later(turns * 5, () => greeted(lobby, 'greet_from_desk', { to: 'Sam' })),
      ),
    ])
    expect([...new Set(said)]).toEqual(['Hello Sam, from the boss'])
  })
})

describe('a value that stops fitting its tool', () => {
  const flagsOf = async () => (await owner('/api/packs/flags')).json._embedded.flags as { pack: string }[]
  let hall = ''
  beforeAll(async () => {
    await packWith('hall', 'Hall', [
      { name: 'fixture.greet', alias: 'greet_default', defaults: { from: 'the porter' } },
      { name: 'fixture.greet', alias: 'greet_fixed', fixed: { from: '{{who}}' } },
      { name: 'fixture.echo' },
    ])
    await owner('/api/packs/hall/variables', {
      method: 'PUT',
      body: { variables: [{ name: 'who', value: 'the desk' }] },
    })
    hall = (await keyFor({ name: 'hall-agent', pack: 'hall' })).key
  })
  afterAll(() => greetTakes(true))

  it('is flagged when the tool drops the input a default fills', async () => {
    expect((await flagsOf()).filter((flag) => flag.pack === 'hall')).toEqual([])
    await greetTakes(false)
    const pack = (await owner('/api/packs/hall')).json
    expect(toolOf(pack, 'greet_default')).toMatchObject({ lostInputs: ['from'], defaults: { from: 'the porter' } })
    expect(toolOf(pack, 'greet_fixed').lostInputs).toEqual(['from'])
    expect(pack.flags).toBe(2)
    expect(pack.findings).toEqual([
      expect.objectContaining({ code: 'unknown_input', path: 'tools.greet_default.defaults.from' }),
      expect.objectContaining({ code: 'unknown_input', path: 'tools.greet_fixed.fixed.from' }),
    ])
    const flags = await flagsOf()
    expect(flags.filter((flag) => flag.pack === 'hall')).toEqual([
      expect.objectContaining({
        kind: 'input',
        tool: 'greet_default',
        was: 'defaults from',
        now: 'fixture.greet no longer takes from',
      }),
      expect.objectContaining({ kind: 'input', tool: 'greet_fixed', was: 'fixes from' }),
    ])
    const nudge = (await owner('/api/overview')).json.nudges.find(
      (found: { kind: string }) => found.kind === 'pack_wording',
    )
    expect(nudge.message).toBe(
      `${flags.length} things in your packs to recheck: tools they were set up for have changed or left their packs.`,
    )
    expect((await owner('/api/packs')).json._embedded.packs).toContainEqual(
      expect.objectContaining({ name: 'hall', flags: 2 }),
    )
    // The pack still sends the value under the old name, and this tool takes no notice of an input it doesn't know
    expect(await greeted(hall, 'greet_default', { to: 'Sam', sender: 'Ada' })).toBe('Hello Sam, from Ada')
    expect(await greeted(hall, 'greet_fixed', { to: 'Sam', sender: 'Ada' })).toBe('Hello Sam, from Ada')
  })

  it('is flagged when the input stays and no longer takes the value', async () => {
    await greetTakes('enum')
    const pack = (await owner('/api/packs/hall')).json
    expect(toolOf(pack, 'greet_default').lostInputs).toEqual([])
    expect(inputOf(toolOf(pack, 'greet_default'), 'from')).toMatchObject({
      mode: 'default',
      value: 'the porter',
      problem: 'from must be equal to one of the allowed values',
    })
    // The other value is one the tool still takes
    expect(inputOf(toolOf(pack, 'greet_fixed'), 'from')).toMatchObject({ resolved: 'the desk', problem: null })
    expect(pack.flags).toBe(1)
    expect((await flagsOf()).filter((flag) => flag.pack === 'hall')).toEqual([
      expect.objectContaining({
        kind: 'input',
        tool: 'greet_default',
        was: 'defaults from',
        now: 'from must be equal to one of the allowed values',
      }),
    ])
    // A default the tool refuses fails only the calls that leave the input out
    expect(await greeted(hall, 'greet_default', { to: 'Sam', from: 'the boss' })).toBe('Hello Sam, from the boss')
    const left = (await greeted(hall, 'greet_default', { to: 'Sam' })) as { status: number; json: { detail: string } }
    expect(left.status).toBe(400)
    expect(left.json.detail).toContain('arguments.from must be equal to one of the allowed values')
  })

  it('refuses a variable’s new value that an input using it no longer takes', async () => {
    const set = await owner('/api/packs/hall/variables', {
      method: 'PUT',
      body: { variables: [{ name: 'who', value: 'the lobby' }] },
    })
    expect(set.status).toBe(400)
    // The sentence names the pack's tool the value breaks, and where to read the inputs of the tool it runs
    expect(set.json.detail).toBe(
      'Not saved: greet_fixed: from must be equal to one of the allowed values. GET /api/tools/fixture.greet shows its inputs.',
    )
    expect(set.json.errors).toEqual([
      {
        in: 'body',
        path: 'tools.greet_fixed.fixed.from',
        message: 'from must be equal to one of the allowed values',
      },
    ])
    const fits = await owner('/api/packs/hall/variables', {
      method: 'PUT',
      body: { variables: [{ name: 'who', value: 'the boss' }] },
    })
    // The default that was already flagged stays a flag: it does not block this change
    expect([fits.status, fits.json.flags]).toEqual([200, 1])
  })

  it('is no longer flagged once the owner sets a value that fits', async () => {
    const fixed = await owner('/api/packs/hall/tools/greet_default', {
      method: 'PATCH',
      body: { defaults: { from: 'the boss' } },
    })
    expect(inputOf(fixed.json, 'from')).toMatchObject({ value: 'the boss', problem: null })
    expect((await owner('/api/packs/hall')).json).toMatchObject({ flags: 0, findings: [] })
  })

  it('is checked the same when the tool keeps the input’s choices beside its inputs, as a $ref', async () => {
    await greetTakes('ref')
    const schema = (await owner('/api/tools/fixture.greet')).json.inputSchema
    expect(schema.properties.from).toEqual({ $ref: '#/$defs/Greeter' })
    expect((await owner('/api/packs/hall')).json).toMatchObject({ flags: 0, findings: [] })
    const refused = await owner('/api/packs/hall/tools/greet_default', {
      method: 'PATCH',
      body: { defaults: { from: 'the porter' } },
    })
    expect([refused.status, refused.json.errors]).toEqual([
      400,
      [
        {
          in: 'body',
          path: 'tools.greet_default.defaults.from',
          message: 'from must be equal to one of the allowed values',
        },
      ],
    ])
    const kept = await owner('/api/packs/hall/tools/greet_default', {
      method: 'PATCH',
      body: { defaults: { from: 'the desk' } },
    })
    expect(inputOf(kept.json, 'from')).toMatchObject({ value: 'the desk', problem: null, unchecked: false })
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
      'Not saved: greet_second: fixture.greet has no input from. GET /api/tools/fixture.greet shows its inputs.',
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

describe('Per person: an input each person fills with their own value', () => {
  let sam: { id: string; key: string }
  let ada: { id: string; key: string }
  let samClient: Client
  const share = (body: Record<string, unknown>) => owner('/api/packs/loft/people', { method: 'POST', body })
  const valuesOf = (client: string, init?: Init) => owner(`/api/packs/loft/people/${client}/values`, init)
  beforeAll(async () => {
    await packWith('loft', 'Loft', [{ name: 'fixture.greet', alias: 'greet_desk', fixed: { from: 'the desk' } }])
    const declared = await owner('/api/packs/loft/variables', {
      method: 'PUT',
      body: { variables: [{ name: 'city', value: null, description: 'Where each person greets from.' }] },
    })
    expect([declared.status, declared.json.detail]).toEqual([200, undefined])
    const set = await owner('/api/packs/loft', {
      method: 'PATCH',
      body: { add: { tools: [{ name: 'fixture.greet', alias: 'greet_city', person: { from: '{{city}}' } }] } },
    })
    expect([set.status, set.json.detail]).toEqual([200, undefined])
    const shared = await share({ name: 'Sam', values: { city: 'Porto' } })
    expect([shared.status, shared.json.detail]).toEqual([201, undefined])
    sam = shared.json
    ada = (await share({ name: 'Ada' })).json
    samClient = await mcp(sam.key, '/p/loft/mcp')
  })
  afterAll(async () => {
    await samClient.close()
    await greetTakes(true)
  })

  it('tells the owner the mode, the variable it reads and that each person sets it', async () => {
    const pack = (await owner('/api/packs/loft')).json
    expect(toolOf(pack, 'greet_city')).toMatchObject({ fixed: {}, defaults: {}, person: { from: '{{city}}' } })
    expect(inputOf(toolOf(pack, 'greet_city'), 'from')).toMatchObject({
      mode: 'person',
      value: '{{city}}',
      resolved: null,
      problem: null,
    })
    expect(pack.variables).toEqual([
      {
        name: 'city',
        value: null,
        description: 'Where each person greets from.',
        perPerson: true,
        usedBy: ['greet_city'],
      },
    ])
    expect(pack.findings).toEqual([])
  })

  it('fills each person’s own value, which neither sees in the schema nor may send', async () => {
    expect((await valuesOf(ada.id, { method: 'PUT', body: { values: { city: 'Lisbon' } } })).status).toBe(200)
    for (const schema of [
      (await api(sam.key, '/p/loft/api/tools/greet_city')).json.inputSchema,
      (await api(ada.key, '/p/loft/api/tools/greet_city')).json.inputSchema,
      (await samClient.listTools()).tools.find((tool) => tool.name === 'greet_city')?.inputSchema,
    ]) {
      expect(Object.keys(schema?.properties as object)).toEqual(['to'])
      expect(schema?.required).toEqual(['to'])
    }
    expect(await greeted(sam.key, 'greet_city', { to: 'Ada' })).toBe('Hello Ada, from Porto')
    expect(await greeted(ada.key, 'greet_city', { to: 'Sam' })).toBe('Hello Sam, from Lisbon')
    expect(await said(samClient, 'greet_city', { to: 'Ada' })).toBe('Hello Ada, from Porto')
    expect(await said(samClient, 'call_tool', { name: 'greet_city', arguments: { to: 'Ada' } })).toBe(
      'Hello Ada, from Porto',
    )
    const forged = await api(sam.key, '/api/calls', {
      method: 'POST',
      body: { tool: 'greet_city', arguments: { to: 'Ada', from: 'Lisbon' } },
    })
    expect([forged.status, forged.json.detail]).toEqual([400, 'greet_city: Loft fills from itself, so leave it out.'])
    // The log keeps what the caller sent: Sam's value is in no call as anyone reads it
    const calls = (await owner('/api/calls?tool=fixture.greet&limit=100')).json._embedded.calls as {
      id: string
      clientId: string
      status: string
    }[]
    const samsCall = calls.find((call) => call.clientId === sam.id && call.status === 'ok')
    expect((await owner(`/api/calls/${samsCall?.id}/payload`)).json.arguments).toEqual({ to: 'Ada' })
  })

  it('takes the person’s value, else the pack’s, else sends nothing and leaves the tool its own default', async () => {
    expect((await valuesOf(ada.id, { method: 'PUT', body: { values: {} } })).status).toBe(200)
    const none = await api(ada.key, '/api/calls', {
      method: 'POST',
      body: { tool: 'greet_city', arguments: { to: 'Sam' } },
    })
    expect(none.status).toBe(409)
    expect(none.json.detail).toBe(
      'greet_city needs city, which has no value for you in Loft: ask the owner to set yours.',
    )
    expect(none.json.detail).not.toContain('from')
    // Still hidden: the input is the pack's to fill, with or without a value
    expect(Object.keys((await api(ada.key, '/p/loft/api/tools/greet_city')).json.inputSchema.properties)).toEqual([
      'to',
    ])

    await owner('/api/packs/loft/variables', {
      method: 'PUT',
      body: { variables: [{ name: 'city', value: 'the lobby', description: null }] },
    })
    expect(await greeted(ada.key, 'greet_city', { to: 'Sam' })).toBe('Hello Sam, from the lobby')
    expect(await greeted(sam.key, 'greet_city', { to: 'Ada' })).toBe('Hello Ada, from Porto')
    // A fixed value that writes the same variable is the pack's: a person's value never reaches it
    await owner('/api/packs/loft/tools/greet_desk', { method: 'PATCH', body: { fixed: { from: '{{city}}' } } })
    expect(await greeted(sam.key, 'greet_desk', { to: 'Ada' })).toBe('Hello Ada, from the lobby')
    await owner('/api/packs/loft/tools/greet_desk', { method: 'PATCH', body: { fixed: { from: 'the desk' } } })

    await owner('/api/packs/loft/variables', {
      method: 'PUT',
      body: { variables: [{ name: 'city', value: null, description: null }] },
    })
    await greetTakes('optional')
    expect(await greeted(ada.key, 'greet_city', { to: 'Sam' })).toBe('Hello Sam, from the house')
    expect(await greeted(sam.key, 'greet_city', { to: 'Ada' })).toBe('Hello Ada, from Porto')
    await greetTakes(true)
  })

  it('lets the owner read and set a person’s values, checked against every input that reads them', async () => {
    const read = await valuesOf(sam.id)
    expect(read.status).toBe(200)
    expect(read.json).toMatchObject({
      client: sam.id,
      name: 'Sam',
      values: [{ name: 'city', description: null, value: 'Porto', packValue: null, usedBy: ['greet_city'] }],
    })
    const wrong = await valuesOf(sam.id, { method: 'PUT', body: { values: { city: 7 } } })
    expect(wrong.status).toBe(400)
    expect(wrong.json.detail).toBe('Not saved: city doesn’t fit greet_city: from must be string.')
    expect(wrong.json.errors).toEqual([
      { in: 'body', path: 'values.city', message: 'city doesn’t fit greet_city: from must be string' },
    ])
    const other = await valuesOf(sam.id, { method: 'PUT', body: { values: { town: 'Porto' } } })
    expect([other.status, other.json.errors[0].path]).toEqual([400, 'values.town'])
    expect((await valuesOf(sam.id)).json.values[0].value).toBe('Porto')

    const people = (await owner('/api/packs/loft/people')).json._embedded.people as { name: string; values: unknown }[]
    expect(people.map((person) => [person.name, person.values])).toEqual([
      ['Sam', { city: 'Porto' }],
      ['Ada', {}],
    ])
    expect((await valuesOf('cl_nobody')).status).toBe(404)
    expect((await api(sam.key, `/api/packs/loft/people/${sam.id}/values`)).status).toBe(403)
  })

  it('refuses a share whose values don’t fit, and makes no key', async () => {
    const before = (await owner('/api/packs/loft/people')).json.count
    const refused = await share({ name: 'Ola', values: { city: 7 } })
    expect([refused.status, refused.json.detail]).toEqual([
      400,
      'Not saved: city doesn’t fit greet_city: from must be string.',
    ])
    expect((await owner('/api/packs/loft/people')).json.count).toBe(before)
  })

  it('flags a person’s value the tool stops taking, and refuses their call naming the variable', async () => {
    await greetTakes('enum')
    const pack = (await owner('/api/packs/loft')).json
    expect(inputOf(toolOf(pack, 'greet_city'), 'from').problem).toBe(
      'Sam’s city no longer fits: from must be equal to one of the allowed values',
    )
    expect(pack.flags).toBe(1)
    expect(
      (await owner('/api/packs/flags')).json._embedded.flags.filter((flag: { pack: string }) => flag.pack === 'loft'),
    ).toEqual([
      expect.objectContaining({
        kind: 'input',
        tool: 'greet_city',
        was: 'fills from per person',
        now: 'Sam’s city no longer fits: from must be equal to one of the allowed values',
      }),
    ])
    const refused = await api(sam.key, '/api/calls', {
      method: 'POST',
      body: { tool: 'greet_city', arguments: { to: 'Ada' } },
    })
    expect(refused.status).toBe(409)
    expect(refused.json.detail).toBe(
      'greet_city can’t run: the value of city Loft uses for you no longer fits it. Ask the owner to change it.',
    )
    expect(refused.json.detail).not.toContain('from')
    expect((await valuesOf(sam.id, { method: 'PUT', body: { values: { city: 'the boss' } } })).status).toBe(200)
    expect(await greeted(sam.key, 'greet_city', { to: 'Ada' })).toBe('Hello Ada, from the boss')
    expect((await owner('/api/packs/loft')).json.flags).toBe(0)
    await greetTakes(true)
  })

  it('carries the mode in the export, and no person’s values', async () => {
    const config = (await owner('/api/config')).json
    const loft = config.packs.find((pack: { name: string }) => pack.name === 'loft')
    expect(loft.tools.find((tool: { alias: string }) => tool.alias === 'greet_city')).toMatchObject({
      person: { from: '{{city}}' },
    })
    expect(loft.variables).toEqual([{ name: 'city', value: null, description: null }])
    // Sam's value is the boss now, which no other value of Loft is
    expect(JSON.stringify(loft)).not.toContain('the boss')
    expect(JSON.stringify(config)).not.toContain('Porto')

    // And back in, as a pack of its own: the variable with no value comes first, so the input that reads it is taken
    const back = await owner('/api/config', {
      method: 'POST',
      body: { upstreams: [], packs: [{ ...loft, name: 'loft-copy' }] },
    })
    expect([back.status, back.json.packs.created, back.json.skipped]).toEqual([200, ['loft-copy'], []])
    const copy = (await owner('/api/packs/loft-copy')).json
    expect(toolOf(copy, 'greet_city').person).toEqual({ from: '{{city}}' })
    expect(copy.variables[0]).toMatchObject({ name: 'city', value: null, perPerson: true })
    expect((await owner('/api/packs/loft-copy', { method: 'DELETE' })).status).toBe(204)
  })

  it('forgets a person’s values when their key is revoked', async () => {
    expect((await owner(`/api/clients/${ada.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await valuesOf(ada.id)).status).toBe(404)
  })
})
