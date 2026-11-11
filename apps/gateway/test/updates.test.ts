/**
 * Updates: the gateway asks for the newest version with one plain request, shows it, and never updates itself: asked
 * to, it leaves a request beside its data for the updater, or calls the platform's deploy hook.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { createUpdates } from '../src/features/updates/index.js'
import { hashApiKey, openDb } from '../src/kit/index.js'

const OWNER = 'owner-key-for-updates'
const HOOK_TOKEN = 'hook-token-never-shown'

type Asked = { url: string; init: RequestInit }

const start = async (
  env: Record<string, string> = {},
  answer: (asked: Asked) => Response | Promise<Response> = () => Response.json({ latest: '9.9.9' }),
  { wired = true } = {},
) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-updates-'))
  const app = await createApp({
    db: await openDb(`file:${join(stateDir, 'state.sqlite')}`),
    env: {
      API_KEYS: `owner:${hashApiKey(OWNER)}`,
      GATEWAY_MASTER_KEY: randomBytes(32).toString('base64'),
      STATE_DIR: stateDir,
      ...env,
    },
  })
  const asked: Asked[] = []
  const updates = createUpdates(
    app.services,
    stateDir,
    (async (url: string, init: RequestInit = {}) => {
      asked.push({ url, init })
      return answer({ url, init })
    }) as typeof fetch,
    '1.0.0',
  )
  if (wired) app.services.updates.current = updates
  const call = (method: string, path: string, body?: unknown, key = OWNER) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const dir = join(stateDir, 'updates')
  const write = (file: string, value: unknown) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, file), typeof value === 'string' ? value : JSON.stringify(value))
  }
  const beat = (at = new Date()) => write('updater.json', { at: at.toISOString(), version: '1.0.0' })
  const request = () =>
    existsSync(join(dir, 'request.json')) ? JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')) : null
  return { call, updates, asked, dir, write, beat, request }
}

const run = (given: Record<string, unknown> = {}) => ({
  id: 'run-1',
  state: 'done',
  step: 'Done',
  from: '1.0.0',
  to: '1.1.0',
  startedAt: '2026-11-10T10:00:00.000Z',
  at: '2026-11-10T10:01:00.000Z',
  detail: null,
  ...given,
})

describe('the switches', () => {
  it('start as the environment says, and Settings wins from then on', async () => {
    const plain = await start()
    expect(await plain.updates.view()).toMatchObject({ check: true, auto: false })
    const seeded = await start({ GATEWAY_UPDATE_CHECK: 'off', GATEWAY_AUTO_UPDATE: 'on' })
    expect(await seeded.updates.view()).toMatchObject({ check: false, auto: true })
    const changed = await seeded.call('PATCH', '/api/system/updates', { check: true, auto: false })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({ check: true, auto: false })
    // One switch leaves the other as it was
    await seeded.call('PATCH', '/api/system/updates', { check: false })
    expect(await seeded.updates.view()).toMatchObject({ check: false, auto: false })
  })

  it('refuse automatic updates where no updater runs', async () => {
    const { call, beat } = await start()
    const refused = await call('PATCH', '/api/system/updates', { auto: true })
    expect(refused.status).toBe(409)
    expect((await refused.json()).detail).toMatch(/need the updater container/)
    // An updater that last wrote long ago isn't there either
    beat(new Date(Date.now() - 5 * 60_000))
    expect((await call('PATCH', '/api/system/updates', { auto: true })).status).toBe(409)
    beat()
    expect(await (await call('PATCH', '/api/system/updates', { auto: true })).json()).toMatchObject({
      auto: true,
      updater: { present: true, version: '1.0.0' },
      how: 'updater',
    })
  })
})

describe('the check', () => {
  it('is one plain request: no id, no body, no key', async () => {
    const { call, asked } = await start({ GATEWAY_UPDATE_URL: 'http://127.0.0.1:9/v1/yardhand/latest' })
    const checked = await call('POST', '/api/system/updates/check')
    expect(checked.status).toBe(200)
    expect(await checked.json()).toMatchObject({
      current: '1.0.0',
      latest: { version: '9.9.9', notes: 'https://github.com/escalay/yardhand/releases/tag/v9.9.9' },
      newer: true,
      checkUrl: 'http://127.0.0.1:9/v1/yardhand/latest',
      how: 'manual',
    })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.url).toBe('http://127.0.0.1:9/v1/yardhand/latest')
    expect(asked[0]?.init.body).toBeUndefined()
    expect(asked[0]?.init.method ?? 'GET').toBe('GET')
    expect(JSON.stringify(asked[0]?.init.headers)).not.toMatch(/authorization|cookie/i)
  })

  it('takes nothing but a version for an answer, and builds the notes link itself', async () => {
    for (const latest of ['v9.9.9', '9.9', '9.9.9-beta', '9.9.9 && rm -rf /', 'https://evil.example.test', 9, null]) {
      const { call, updates } = await start({}, () => Response.json({ latest, notes: 'https://evil.example.test' }))
      const failed = await call('POST', '/api/system/updates/check')
      expect(failed.status).toBe(503)
      expect((await failed.json()).detail).toMatch(/didn’t name a version/)
      expect((await updates.view()).latest).toBeNull()
    }
    const down = await start({}, () => new Response('no', { status: 500 }))
    const failed = await down.call('POST', '/api/system/updates/check')
    expect(failed.status).toBe(503)
    expect((await failed.json()).detail).toMatch(/answered 500[\s\S]*tries again/)
  })

  it('says up to date when the newest is the one running', async () => {
    const { updates } = await start({}, () => Response.json({ latest: '1.0.0' }))
    expect(await updates.daily()).toBe('Up to date: 1.0.0 is the newest')
    expect(await updates.view()).toMatchObject({ newer: false, latest: { version: '1.0.0' } })
  })
})

describe('asking for an update', () => {
  it('leaves a whole request for the updater, and nothing else in the folder', async () => {
    const { call, beat, request, dir } = await start()
    beat()
    await call('POST', '/api/system/updates/check')
    const asked = await call('POST', '/api/system/updates/requests', {})
    expect(asked.status).toBe(202)
    expect(request()).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      version: '9.9.9',
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })
    expect(readdirSync(dir).sort()).toEqual(['request.json', 'updater.json'])
    // A version named in the call wins over the newest known
    await call('POST', '/api/system/updates/requests', { version: '2.0.0' })
    expect(request().version).toBe('2.0.0')
  })

  it('is refused with what to do when it can’t happen', async () => {
    const { call, beat, write, request } = await start()
    const detailOf = async (body?: unknown) => {
      const response = await call('POST', '/api/system/updates/requests', body)
      expect(response.status).toBe(409)
      return (await response.json()).detail as string
    }
    beat()
    expect(await detailOf({})).toMatch(/No newer version is known yet/)
    expect(await detailOf({ version: 'v2.0.0' })).toMatch(/isn’t a version/)
    expect(await detailOf({ version: '2.0.0; reboot' })).toMatch(/isn’t a version/)
    expect(await detailOf({ version: '1.0.0' })).toMatch(/isn’t newer/)
    expect(await detailOf({ version: '0.9.0' })).toMatch(/isn’t newer/)
    write('status.json', run({ state: 'working', step: 'Checking the signature', to: '2.0.0' }))
    expect(await detailOf({ version: '2.0.0' })).toMatch(/already under way \(Checking the signature\)/)
    expect(request()).toBeNull()
  })

  it('gives the commands where neither an updater nor a hook is there', async () => {
    const { call, request } = await start()
    const refused = await call('POST', '/api/system/updates/requests', { version: '2.0.0' })
    expect(refused.status).toBe(409)
    expect((await refused.json()).detail).toMatch(/docker compose pull && docker compose up -d/)
    expect(request()).toBeNull()
  })

  it('calls the deploy hook with its token where no updater runs, and never says the token', async () => {
    const env = { GATEWAY_UPDATE_HOOK: 'https://deploy.example.test/hook', GATEWAY_UPDATE_HOOK_TOKEN: HOOK_TOKEN }
    const fine = await start(env, () => new Response(null, { status: 204 }))
    const asked = await fine.call('POST', '/api/system/updates/requests', { version: '2.0.0' })
    expect(asked.status).toBe(202)
    const body = await asked.text()
    expect(JSON.parse(body)).toMatchObject({ how: 'hook', hook: true })
    expect(body).not.toContain(HOOK_TOKEN)
    expect(body).not.toContain('deploy.example.test')
    expect(fine.asked).toHaveLength(1)
    expect(fine.asked[0]).toMatchObject({
      url: 'https://deploy.example.test/hook',
      init: { method: 'POST', headers: { authorization: `Bearer ${HOOK_TOKEN}` } },
    })
    expect(fine.request()).toBeNull()

    const broken = await start(env, () => new Response(`bad token ${HOOK_TOKEN}`, { status: 401 }))
    const failed = await broken.call('POST', '/api/system/updates/requests', { version: '2.0.0' })
    expect(failed.status).toBe(503)
    const said = await failed.text()
    expect(said).toMatch(/answered 401/)
    expect(said).not.toContain(HOOK_TOKEN)
    expect(said).not.toContain('deploy.example.test')
  })
})

describe('the daily job', () => {
  it('asks nobody while the check is off', async () => {
    const { updates, asked } = await start({ GATEWAY_UPDATE_CHECK: 'off' })
    expect(await updates.daily()).toMatch(/^Off: /)
    expect(asked).toEqual([])
  })

  it('only tells the owner, unless automatic updates are on', async () => {
    const { updates, beat, request } = await start()
    beat()
    expect(await updates.daily()).toBe('9.9.9 is out (this is 1.0.0)')
    expect(request()).toBeNull()
  })

  it('asks the updater by itself only when one is there, idle, and that version hasn’t failed before', async () => {
    const gone = await start({ GATEWAY_AUTO_UPDATE: 'on' })
    expect(await gone.updates.daily()).toMatch(/need the updater/)
    expect(gone.request()).toBeNull()

    const busy = await start({ GATEWAY_AUTO_UPDATE: 'on' })
    busy.beat()
    busy.write('status.json', run({ state: 'working' }))
    expect(await busy.updates.daily()).toMatch(/already under way/)
    expect(busy.request()).toBeNull()

    for (const state of ['failed', 'refused']) {
      const burnt = await start({ GATEWAY_AUTO_UPDATE: 'on' })
      burnt.beat()
      burnt.write('history.jsonl', `${JSON.stringify(run({ state, to: '9.9.9', detail: 'It never came up' }))}\n`)
      expect(await burnt.updates.daily()).toMatch(/not tried again by itself/)
      expect(burnt.request()).toBeNull()
    }

    const ready = await start({ GATEWAY_AUTO_UPDATE: 'on' })
    ready.beat()
    // An older version that failed doesn't hold this one back
    ready.write('history.jsonl', `${JSON.stringify(run({ state: 'failed', to: '9.0.0' }))}\n`)
    expect(await ready.updates.daily()).toMatch(/asked the updater to install it/)
    expect(ready.request()).toMatchObject({ version: '9.9.9' })
  })
})

describe('what the updater wrote', () => {
  it('is shown: the run under way and the last 20, newest first', async () => {
    const { call, write } = await start()
    write('status.json', run({ id: 'run-30' }))
    write(
      'history.jsonl',
      Array.from({ length: 30 }, (_, index) => JSON.stringify(run({ id: `run-${index + 1}` }))).join('\n'),
    )
    const view = await (await call('GET', '/api/system/updates')).json()
    expect(view.status).toMatchObject({ id: 'run-30', state: 'done' })
    expect(view.history).toHaveLength(20)
    expect(view.history[0].id).toBe('run-30')
    expect(view.history[19].id).toBe('run-11')
  })

  it('reads as nothing when it is missing, half-written or something else', async () => {
    const { call, write } = await start()
    write('status.json', '{"id":"run-1","state":"work')
    write('updater.json', '[]')
    write('history.jsonl', `not json\n{"state":"done"}\n${JSON.stringify(run())}\n{"id":`)
    const response = await call('GET', '/api/system/updates')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: null,
      updater: { present: false, version: null },
      history: [{ id: 'run-1' }],
    })
  })
})

describe('the routes', () => {
  it('are the owner’s only, and are linked from the system', async () => {
    const { call } = await start()
    const client = (await (
      await call('POST', '/api/clients', { name: 'a script', scope: 'write', upstreams: 'all' })
    ).json()) as { key: string }
    expect((await call('GET', '/api/system/updates', undefined, client.key)).status).toBe(403)
    expect((await call('POST', '/api/system/updates/requests', {}, client.key)).status).toBe(403)
    expect((await call('PATCH', '/api/system/updates', { check: false }, client.key)).status).toBe(403)
    expect((await call('GET', '/api/system/updates', undefined, 'nobody')).status).toBe(401)
    const system = await (await call('GET', '/api/system')).json()
    expect(system._links.updates.href).toMatch(/\/api\/system\/updates$/)
  })

  it('say so where a test process runs without updates', async () => {
    const { call } = await start({}, undefined, { wired: false })
    const response = await call('GET', '/api/system/updates')
    expect(response.status).toBe(409)
    expect((await response.json()).detail).toMatch(/runs without updates/)
  })
})
