/**
 * An upstream that asks mid-call (MCP 2026-07-28 input requests) and reports progress: the gateway passes the
 * questions to a caller that can answer and the answers back, answers for a caller that can't (and says so), refuses
 * answers that don't belong to the call, and passes progress on.
 */
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-asking'
const upstream = await startUpstream({ token: 'fixture-token', asking: true })
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

const api = async (key: string, path: string, init: { method?: string; body?: unknown } = {}) => {
  const response = await app.request(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  return { status: response.status, json: (await response.json().catch(() => null)) as any }
}
const text = (result: any) => result.content.map((block: { text?: string }) => block.text ?? '').join('\n')

let agentKey = ''
beforeAll(async () => {
  await api(OWNER, '/api/upstreams', {
    method: 'POST',
    body: { id: 'fixture', url: upstream.url, trust: 'trusted', auth: { type: 'bearer', value: 'fixture-token' } },
  })
  agentKey = (
    await api(OWNER, '/api/clients', { method: 'POST', body: { name: 'agent', scope: 'read', upstreams: 'all' } })
  ).json.key
})

describe('over REST', () => {
  it('declines for a caller that can’t answer, and says so in the result', async () => {
    const { json } = await api(agentKey, '/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.delete_menus', arguments: { count: 3 } },
    })
    expect(json.status).toBe('ok')
    expect(json.asked).toBeNull()
    expect(text(json.result)).toContain('Kept them (count:3)')
    expect(text(json.result)).toContain('the server asked "Delete 3 menus?" (confirm)')
    expect(text(json.result)).toContain('declined')
  })

  it('hands an interactive caller the question, and goes on with its answer', async () => {
    const asked = await api(agentKey, '/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.delete_menus', arguments: { count: 2 }, interactive: true },
    })
    expect(asked.json.status).toBe('asked')
    expect(asked.json.asked.inputRequests.confirm).toMatchObject({
      method: 'elicitation/create',
      params: { message: 'Delete 2 menus?' },
    })
    // The upstream's own state stays inside the gateway's sealed one
    expect(asked.json.asked.requestState.startsWith('gw1.')).toBe(true)
    expect(asked.json.asked.requestState).not.toContain('count:2')
    const answered = await api(agentKey, '/api/calls', {
      method: 'POST',
      body: {
        tool: 'fixture.delete_menus',
        arguments: { count: 2 },
        answers: {
          inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
          requestState: asked.json.asked.requestState,
        },
      },
    })
    expect(answered.json.status).toBe('ok')
    expect(text(answered.json.result)).toBe('Deleted 2 menus (count:2)')
    const log = (await api(OWNER, '/api/calls?tool=fixture.delete_menus')).json._embedded.calls
    expect(log.map((call: { status: string }) => call.status).slice(0, 2)).toEqual(['ok', 'asked'])
    expect((await api(OWNER, `/api/calls/${asked.json.id}/payload`)).json.asked.confirm.params.message).toBe(
      'Delete 2 menus?',
    )
  })

  it('refuses answers that belong to another call, or that it never handed out', async () => {
    const asked = await api(agentKey, '/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.delete_menus', arguments: { count: 5 }, interactive: true },
    })
    const answers = {
      inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
      requestState: asked.json.asked.requestState,
    }
    const otherArguments = await api(agentKey, '/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.delete_menus', arguments: { count: 50 }, answers },
    })
    expect(otherArguments.status).toBe(400)
    expect(otherArguments.json.detail).toContain('belong to another call')
    const otherClient = await api(OWNER, '/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.delete_menus', arguments: { count: 5 }, answers },
    })
    expect(otherClient.status).toBe(400)
    const forged = await api(agentKey, '/api/calls', {
      method: 'POST',
      body: {
        tool: 'fixture.delete_menus',
        arguments: { count: 5 },
        answers: { ...answers, requestState: 'count:5' },
      },
    })
    expect(forged.json.detail).toContain('not one the gateway gave')
  })

  it('stops with the reason when the server wants the caller’s model and the caller can’t lend it', async () => {
    const { status, json } = await api(agentKey, '/api/calls', {
      method: 'POST',
      body: { tool: 'fixture.summarize', arguments: {} },
    })
    expect(status).toBe(400)
    expect(json.detail).toContain('asked to use your model (sampling)')
  })
})

describe('over MCP', () => {
  const connect = async (options: ConstructorParameters<typeof Client>[1] = {}) => {
    const client = new Client({ name: 'test', version: '1.0.0' }, options)
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        requestInit: { headers: { authorization: `Bearer ${agentKey}` } },
      }),
    )
    return client
  }

  it('asks an agent that can answer, and goes on with its answer', async () => {
    const seen: string[] = []
    const client = await connect({ versionNegotiation: { mode: 'auto' }, capabilities: { elicitation: {} } })
    client.setRequestHandler('elicitation/create', async (request) => {
      seen.push(String((request.params as { message?: string }).message))
      return { action: 'accept', content: { confirm: true } }
    })
    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'fixture.delete_menus', arguments: { count: 4 } },
    })
    expect(seen).toEqual(['Delete 4 menus?'])
    expect(text(result)).toBe('Deleted 4 menus (count:4)')
    await client.close()
  })

  it('declines for an older agent, and says so', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'fixture.delete_menus', arguments: { count: 1 } },
    })
    expect(text(result)).toContain('Kept them')
    expect(text(result)).toContain('declined')
    await client.close()
  })

  it('passes the server’s progress on to the agent, and to the owner’s live view', async () => {
    const live: number[] = []
    const stop = app.services.events.subscribe((event) => {
      if (event.type === 'progress') live.push(event.data.progress)
    })
    const steps: { progress: number; message?: string }[] = []
    const client = await connect({ versionNegotiation: { mode: 'auto' } })
    const result = await client.callTool(
      { name: 'call_tool', arguments: { name: 'fixture.count_slowly', arguments: {} } },
      { onprogress: (step) => steps.push({ progress: step.progress, message: step.message }) },
    )
    stop()
    expect(text(result)).toBe('counted')
    expect(steps.map((step) => step.progress)).toEqual([1, 2, 3])
    expect(steps[0]?.message).toBe('step 1')
    expect(live).toEqual([1, 2, 3])
    await client.close()
  })
})
