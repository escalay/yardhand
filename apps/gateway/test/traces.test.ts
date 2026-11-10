/**
 * Traces join the agent's own: a call carrying W3C trace context (MCP `_meta.traceparent`, or a `traceparent` header
 * on REST) becomes a span in the caller's trace in Langfuse; a call without one stays a trace of its own.
 */
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { startUpstream } from './fixtures/upstream.js'

type Event = { type: string; body: Record<string, unknown> }
const events: Event[] = []
const langfuse = serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: async (request) => {
    if (new URL(request.url).pathname === '/api/public/projects') return Response.json({ data: [{ id: 'proj_1' }] })
    events.push(...((await request.json()) as { batch: Event[] }).batch)
    return new Response('{}', { status: 207 })
  },
})
await new Promise<void>((resolve) => langfuse.once('listening', () => resolve()))

const OWNER = 'owner-key-for-traces'
const upstream = await startUpstream({ token: 'fixture-token' })
const app = await createApp({
  db: await testDb(),
  env: {
    API_KEYS: `owner:${hashApiKey(OWNER)}`,
    GATEWAY_MASTER_KEY: randomBytes(32).toString('base64'),
    GATEWAY_LANGFUSE_URL: `http://127.0.0.1:${(langfuse.address() as AddressInfo).port}`,
    GATEWAY_LANGFUSE_PUBLIC_KEY: 'pk',
    GATEWAY_LANGFUSE_SECRET_KEY: 'sk',
  },
})
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
await new Promise<void>((resolve) => server.once('listening', () => resolve()))
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
afterAll(async () => {
  app.services.traces?.stop()
  await upstream.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => langfuse.close(() => resolve()))
})

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN = '00f067aa0ba902b7'
const call = (headers: Record<string, string>, text: string) =>
  app.request('/api/calls', {
    method: 'POST',
    headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ tool: 'fixture.echo', arguments: { text } }),
  })
const sent = async () => {
  await app.services.traces?.flush()
  return events
}
const spanOf = (all: Event[], name: string) =>
  all.find((event) => event.body.name === name && event.type === 'span-create')

beforeAll(async () => {
  const created = await app.request('/api/upstreams', {
    method: 'POST',
    headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'fixture',
      title: 'Fixture',
      url: upstream.url,
      auth: { type: 'bearer', value: 'fixture-token' },
    }),
  })
  expect(created.status).toBe(201)
})

describe('traces', () => {
  it('a REST call with a traceparent is a span in the caller’s trace, under the caller’s span', async () => {
    expect((await call({ traceparent: `00-${TRACE}-${SPAN}-01` }, 'rest traced')).status).toBe(200)
    const span = spanOf(await sent(), 'gateway fixture.echo')
    expect(span?.body).toMatchObject({
      traceId: TRACE,
      parentObservationId: SPAN,
      level: 'DEFAULT',
      metadata: { tool: 'fixture.echo', upstream: 'fixture', status: 'ok' },
    })
    expect(Date.parse(String(span?.body.endTime))).toBeGreaterThanOrEqual(Date.parse(String(span?.body.startTime)))
  })

  it('an MCP call carrying _meta.traceparent joins the agent’s trace too', async () => {
    events.length = 0
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        requestInit: { headers: { authorization: `Bearer ${OWNER}` } },
      }),
    )
    const result = await client.callTool({
      name: 'call_tool',
      arguments: { name: 'fixture.echo', arguments: { text: 'mcp traced' } },
      _meta: { traceparent: `00-${TRACE}-aaaaaaaaaaaaaaaa-01` },
    })
    expect(result.isError).toBeFalsy()
    await client.close()
    expect(spanOf(await sent(), 'gateway fixture.echo')?.body).toMatchObject({
      traceId: TRACE,
      parentObservationId: 'aaaaaaaaaaaaaaaa',
      metadata: { via: 'mcp' },
    })
  })

  it('a call without one, or with a broken one, stays a trace of its own', async () => {
    events.length = 0
    await call({}, 'plain')
    await call({ traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' }, 'zeros')
    await call({ traceparent: 'not a trace' }, 'broken')
    const all = await sent()
    expect(all.map((event) => event.type)).toEqual(['trace-create', 'trace-create', 'trace-create'])
  })

  it('links each call to its trace: inside the caller’s trace, or its own', async () => {
    const page = await app.request('/api/calls?limit=10', { headers: { authorization: `Bearer ${OWNER}` } })
    const calls = ((await page.json()) as { _embedded: { calls: { id: string; traceUrl: string | null }[] } })._embedded
      .calls
    const traced = calls.filter((call) => call.traceUrl?.includes(`/traces/${TRACE}?observation=${call.id}`))
    const own = calls.filter((call) => call.traceUrl?.endsWith(`/project/proj_1/traces/${call.id}`))
    expect(traced).toHaveLength(2)
    expect(own).toHaveLength(3)
  })
})
