/**
 * Usage telemetry: the report carries ranges and yes/no answers and nothing an owner named; it waits a day, goes once
 * asked, and never goes when switched off. Its owner reads the exact report at GET /api/system/telemetry.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { createTelemetry, offReason } from '../src/features/telemetry/index.js'
import { countRange, daysRange, sizeRange } from '../src/features/telemetry/report.js'
import { ReportSchema } from '../src/features/telemetry/routes.js'
import { hashApiKey, openDb } from '../src/kit/index.js'

const OWNER = 'owner-key-for-telemetry'
const DAY = 24 * 60 * 60 * 1000

const start = async (env: Record<string, string> = {}) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-telemetry-'))
  const app = await createApp({
    db: await openDb(`file:${join(stateDir, 'state.sqlite')}`),
    env: {
      API_KEYS: `owner:${hashApiKey(OWNER)}`,
      GATEWAY_MASTER_KEY: randomBytes(32).toString('base64'),
      STATE_DIR: stateDir,
      PUBLIC_HOST: 'gateway.secret-company.example.test',
      ...env,
    },
  })
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const sent: { url: string; body: any }[] = []
  const telemetry = createTelemetry(
    app.services,
    () => ({ claimed: true, install: 'compose', arch: 'arm64', databaseBytes: 2_000_000 }),
    (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) })
      return Response.json({ ok: true, latest: '9.9.9' })
    }) as typeof fetch,
  )
  const get = (path: string, key = OWNER) => app.request(path, { headers: { authorization: `Bearer ${key}` } })
  return { app, post, get, telemetry, sent }
}

describe('ranges', () => {
  it('say a number without giving it away', () => {
    expect([0, 1, 10, 11, 100, 1000, 1001, 10_000, 10_001].map(countRange)).toEqual([
      '0',
      '1-10',
      '1-10',
      '11-100',
      '11-100',
      '101-1k',
      '1k-10k',
      '1k-10k',
      '10k+',
    ])
    expect([0, 7, 8, 400].map(daysRange)).toEqual(['0', '1-7', '8-30', '365+'])
    expect([1, 50_000_000, 5_000_000_000].map(sizeRange)).toEqual(['<10MB', '10-100MB', '1GB+'])
  })
})

describe('the off switch', () => {
  it('is GATEWAY_TELEMETRY=off or DO_NOT_TRACK=1, and nothing else', () => {
    expect(offReason({})).toBeNull()
    expect(offReason({ GATEWAY_TELEMETRY: 'on' })).toBeNull()
    expect(offReason({ GATEWAY_TELEMETRY: 'off' })).toBe('GATEWAY_TELEMETRY is off')
    expect(offReason({ GATEWAY_TELEMETRY: 'false' })).toBe('GATEWAY_TELEMETRY is off')
    expect(offReason({ DO_NOT_TRACK: '1', GATEWAY_TELEMETRY: 'on' })).toBe('DO_NOT_TRACK is set')
  })

  it('sends nothing, ever', async () => {
    const { telemetry, sent } = await start({ GATEWAY_TELEMETRY: 'off' })
    expect(await telemetry.send(new Date(Date.now() + 30 * DAY))).toBe('Off: GATEWAY_TELEMETRY is off')
    expect(sent).toEqual([])
  })
})

describe('the report', () => {
  it('waits a day after the instance first could send one, then goes daily to the address set', async () => {
    const { telemetry, sent } = await start({ GATEWAY_TELEMETRY_URL: 'http://127.0.0.1:9/v1/yardhand' })
    expect(await telemetry.send()).toMatch(/^Waiting: the first report goes after /)
    expect(sent).toEqual([])
    expect(await telemetry.send(new Date(Date.now() + DAY + 1000))).toBe('Sent')
    expect(sent.map(({ url }) => url)).toEqual(['http://127.0.0.1:9/v1/yardhand'])
    const view = await telemetry.view()
    expect(view.latest).toBe('9.9.9')
    expect(view.sent?.body).toEqual(sent[0]?.body)
  })

  it('carries ranges and yes/no answers, and nothing the owner named', async () => {
    const { post, telemetry, sent } = await start()
    await post('/api/upstreams', {
      id: 'acme-billing',
      kind: 'http',
      url: 'https://billing.secret-company.example.test/api',
      http: { endpoints: [{ name: 'getInvoice', method: 'get', path: '/invoice', description: 'An invoice.' }] },
      auth: { type: 'bearer', value: 'upstream-secret-value' },
      trust: 'trusted',
    })
    await telemetry.send()
    await telemetry.send(new Date(Date.now() + 2 * DAY))
    const [{ body } = { body: null }] = sent
    expect(body).toMatchObject({ schema: 1, version: expect.stringMatching(/^\d+\.\d+\.\d+/) })
    expect(body.instance).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.report).toMatchObject({
      install: 'compose',
      arch: 'arm64',
      age: '1-7',
      https: true,
      database: '<10MB',
      claimed: true,
      connections: '1-10',
      connections_http: true,
      connections_mcp: false,
      tools: '1-10',
      calls: '0',
      ai_grouping: 'off',
    })
    const text = JSON.stringify(body)
    for (const secret of ['acme', 'billing', 'secret-company', 'getInvoice', 'upstream-secret-value', OWNER, 'owner'])
      expect(text).not.toContain(secret)
    for (const value of Object.values(body.report)) expect(['string', 'boolean']).toContain(typeof value)
  })

  it('keeps the same random id from one day to the next', async () => {
    const { telemetry, sent } = await start()
    await telemetry.send()
    await telemetry.send(new Date(Date.now() + 2 * DAY))
    await telemetry.send(new Date(Date.now() + 3 * DAY))
    expect(sent[0]?.body.instance).toBe(sent[1]?.body.instance)
  })
})

describe('GET /api/system/telemetry', () => {
  it('shows the owner what would be sent, field for field, and sends nothing', async () => {
    const { app, get, telemetry, sent } = await start({ GATEWAY_TELEMETRY_URL: 'https://collector.example.test/v1' })
    app.services.telemetry.current = telemetry
    const response = await get('/api/system/telemetry')
    expect(response.status).toBe(200)
    const view = (await response.json()) as any
    expect(view).toMatchObject({
      on: true,
      off: null,
      url: 'https://collector.example.test/v1',
      sent: null,
      latest: null,
      next: { schema: 1, version: expect.stringMatching(/^\d+\.\d+\.\d+/) },
    })
    expect(new Date(view.firstAt).getTime()).toBeGreaterThan(Date.now() + DAY - 60_000)
    expect(Object.keys(view.next).sort()).toEqual(['instance', 'report', 'schema', 'version'])
    // Strict: a field the report gained without the schema naming it fails here
    expect(ReportSchema.parse(view.next.report)).toEqual(view.next.report)
    expect(sent).toEqual([])

    await telemetry.send(new Date(Date.now() + 2 * DAY))
    const after = (await (await get('/api/system/telemetry')).json()) as any
    expect(after.sent.body).toEqual(sent[0]?.body)
    expect(after.latest).toBe('9.9.9')
    expect(after.next.instance).toBe(view.next.instance)
  })

  it('says why it is off', async () => {
    const { app, get, telemetry } = await start({ DO_NOT_TRACK: '1' })
    app.services.telemetry.current = telemetry
    const view = (await (await get('/api/system/telemetry')).json()) as any
    expect(view).toMatchObject({ on: false, off: 'DO_NOT_TRACK is set' })
  })

  it('is the owner’s only, and is linked from the system', async () => {
    const { app, post, get, telemetry } = await start()
    app.services.telemetry.current = telemetry
    const client = (await (
      await post('/api/clients', { name: 'a script', scope: 'read', upstreams: 'all' })
    ).json()) as {
      key: string
    }
    expect((await get('/api/system/telemetry', client.key)).status).toBe(403)
    expect((await app.request('/api/system/telemetry')).status).toBe(401)
    const system = (await (await get('/api/system')).json()) as any
    expect(system._links.telemetry.href).toMatch(/\/api\/system\/telemetry$/)
  })

  it('says so where the process runs without telemetry', async () => {
    const { get } = await start()
    const response = await get('/api/system/telemetry')
    expect(response.status).toBe(409)
    expect(((await response.json()) as any).detail).toMatch(/runs without usage telemetry/)
  })
})

describe('docs/telemetry.md', () => {
  it('lists every field of the report, and no field the report lacks', () => {
    const doc = readFileSync(new URL('../../../docs/telemetry.md', import.meta.url), 'utf8')
    const [, after = ''] = doc.split('### Schema 1')
    const [fields = ''] = after.split('## What is never sent')
    const listed = [...fields.matchAll(/^\| `(\w+)` \|/gm)]
    expect(listed.map((match) => match[1])).toEqual(Object.keys(ReportSchema.shape))
  })
})
