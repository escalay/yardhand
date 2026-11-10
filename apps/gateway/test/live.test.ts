/**
 * Live sync: the gateway listens to an upstream that announces its changes and syncs it soon after, listens again
 * when the stream drops, and tells the agents listening on /mcp when what they see changed.
 */
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { createWatcher } from '../src/features/upstreams/watch.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-live-sync'
const upstream = await startUpstream({ token: 'fixture-token' })
const app = await createApp({
  db: await testDb(),
  env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
})
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
await new Promise<void>((resolve) => server.once('listening', () => resolve()))
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const { upstreams, adapters, credentialOf, sync, tools } = app.services
// The running server's watcher waits five seconds after a notice; this one barely waits
const watcher = createWatcher({ upstreams, adapters, credentialOf, sync, debounceMs: 50, retryMs: [100] })
afterAll(async () => {
  await watcher.stopAll()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const owner = (path: string, init: { method?: string; body?: unknown } = {}) =>
  app.request(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
/** Waits until `check` holds, or fails after a few seconds. */
const eventually = async (check: () => Promise<boolean> | boolean, ms = 4000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('not in time')
}

await owner('/api/upstreams', {
  method: 'POST',
  body: {
    id: 'fixture',
    title: 'Fixture',
    url: upstream.url,
    trust: 'trusted',
    auth: { type: 'bearer', value: 'fixture-token' },
  },
})

describe('listening to an upstream', () => {
  it('syncs soon after the upstream announces a change', async () => {
    await watcher.start()
    await eventually(() => watcher.states()[0]?.state === 'listening')
    expect(await tools.live('fixture.whisper')).toBeUndefined()
    upstream.state.whisper = true
    upstream.announce()
    await eventually(async () => Boolean(await tools.live('fixture.whisper')))
    expect(watcher.states()[0]?.lastChangeAt).toBeTruthy()
  })

  it('listens again when the stream drops', async () => {
    const before = watcher.states()[0]?.since
    upstream.drop()
    await eventually(() => watcher.states()[0]?.state === 'listening' && watcher.states()[0]?.since !== before)
  })

  it('stops listening when the upstream is switched off, and listens again when it is back on', async () => {
    await watcher.stop('fixture')
    expect(watcher.states()).toEqual([])
    await watcher.restart('fixture')
    await eventually(() => watcher.states()[0]?.state === 'listening')
  })
})

describe('telling agents', () => {
  it('tells an agent listening on /mcp when its tools change', async () => {
    let told = 0
    const client = new Client(
      { name: 'listener', version: '1.0.0' },
      {
        versionNegotiation: { mode: 'auto' },
        listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => told++ } },
      },
    )
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        requestInit: { headers: { authorization: `Bearer ${OWNER}` } },
      }),
    )
    await eventually(() => Boolean(client.autoOpenedSubscription))
    await owner('/api/pins', { method: 'PUT', body: { tools: ['fixture.echo'] } })
    await eventually(() => told > 0)
    await client.close()
  })
})
