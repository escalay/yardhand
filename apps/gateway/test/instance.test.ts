/**
 * A first start with nothing set: the instance makes its own keys beside its data, waits for its owner, and the
 * owner claims it once with the setup code. Keys are never made over data that needs other ones.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { readInstance, resetOwner, resolveInstance, setupCode } from '../src/features/instance/keys.js'
import { openDb } from '../src/kit/index.js'
import type { Env } from '../src/services.js'

const fresh = () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-instance-'))
  return { stateDir, databaseFile: join(stateDir, 'state.sqlite') }
}
const start = async (stateDir: string, databaseFile: string, env: Env = {}) => {
  const instance = await resolveInstance(env, stateDir, databaseFile)
  const code = instance.open ? setupCode() : null
  const app = await createApp({
    db: await openDb(`file:${databaseFile}`),
    env: instance.env as Env,
    ...(code ? { unclaimed: { code, claim: instance.claim } } : {}),
  })
  const send = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', origin: 'http://localhost', ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  return { instance, code, send }
}

describe('a new instance', () => {
  it('makes its own keys, waits for its owner, and is claimed once with the setup code', async () => {
    const { stateDir, databaseFile } = fresh()
    const first = await start(stateDir, databaseFile)
    expect(first.instance.problems).toEqual([])
    expect(first.instance.open).toBe(true)
    expect(first.code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/)
    const file = readInstance(stateDir)
    expect(Buffer.from(file.masterKey ?? '', 'base64')).toHaveLength(32)
    expect(file.signingKey).toContain('ES256')
    expect(statSync(join(stateDir, 'instance.json')).mode & 0o777).toBe(0o600)

    expect((await (await first.send('/api/session')).json()).setup).toBe(true)
    expect((await first.send('/api/me')).status).toBe(401)
    const wrong = await first.send('/api/session/claim', { method: 'POST', body: { code: 'AAAA-AAAA' } })
    expect(wrong.status).toBe(401)
    expect((await wrong.json()).detail).toContain('docker compose logs gateway')

    // Typed loosely: lower case, without the dash
    const claimed = await first.send('/api/session/claim', {
      method: 'POST',
      body: { code: (first.code as string).toLowerCase().replace('-', '') },
    })
    expect(claimed.status).toBe(200)
    expect(claimed.headers.get('cache-control')).toBe('no-store')
    const cookie = claimed.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('gw_session=')
    const { key } = (await claimed.json()) as { key: string }
    expect(key).toMatch(/^gw_owner_/)
    expect(readInstance(stateDir).ownerHash).toMatch(/^[0-9a-f]{64}$/)

    // Once only, and the key works right away
    expect((await first.send('/api/session/claim', { method: 'POST', body: { code: first.code } })).status).toBe(409)
    expect((await first.send('/api/me', { headers: { authorization: `Bearer ${key}` } })).status).toBe(200)
    expect((await (await first.send('/api/session')).json()).setup).toBe(false)

    // A restart keeps the keys and the owner, and doesn't open setup again
    const again = await start(stateDir, databaseFile)
    expect(again.instance.open).toBe(false)
    expect(again.code).toBeNull()
    expect(readInstance(stateDir).masterKey).toBe(file.masterKey)
    expect((await again.send('/api/me', { headers: { authorization: `Bearer ${key}` } })).status).toBe(200)

    // A lost owner key: forgetting the owner opens setup at the next start, the data stays
    resetOwner(stateDir)
    const reset = await start(stateDir, databaseFile)
    expect(reset.instance.open).toBe(true)
    expect(readInstance(stateDir).masterKey).toBe(file.masterKey)
  })

  it('is refused from another site', async () => {
    const { stateDir, databaseFile } = fresh()
    const first = await start(stateDir, databaseFile)
    const response = await first.send('/api/session/claim', {
      method: 'POST',
      body: { code: first.code },
      headers: { origin: 'https://elsewhere.example' },
    })
    expect(response.status).toBe(403)
  })

  it('never makes a key over data sealed with another, and names a mismatch', async () => {
    const { stateDir, databaseFile } = fresh()
    const db = new DatabaseSync(databaseFile)
    db.exec(
      "create table secrets (id text primary key, sealed text not null, updated_at text not null); insert into secrets values ('a', 'v1.x.y.z', 'now')",
    )
    db.close()
    const lost = await resolveInstance({}, stateDir, databaseFile)
    expect(lost.problems[0]).toContain('no GATEWAY_MASTER_KEY')
    expect(readInstance(stateDir).masterKey).toBeUndefined()

    const other = fresh()
    await resolveInstance({}, other.stateDir, other.databaseFile)
    const mismatch = await resolveInstance(
      { GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
      other.stateDir,
      other.databaseFile,
    )
    expect(mismatch.problems[0]).toContain('differs')
  })

  it('takes its keys from the environment when they are set, and is owned already', async () => {
    const { stateDir, databaseFile } = fresh()
    const key = randomBytes(32).toString('base64')
    const set = await resolveInstance(
      { GATEWAY_MASTER_KEY: key, API_KEYS: `owner:${'a'.repeat(64)}` },
      stateDir,
      databaseFile,
    )
    expect(set.open).toBe(false)
    expect(set.env.GATEWAY_MASTER_KEY).toBe(key)
    expect(readInstance(stateDir).masterKey).toBeUndefined()
    expect(set.masterKeyFrom).toBe('env')
  })

  it('offers sample tools to try every step with, nothing leaving the machine', async () => {
    const { stateDir, databaseFile } = fresh()
    const first = await start(stateDir, databaseFile)
    const claimed = await first.send('/api/session/claim', { method: 'POST', body: { code: first.code } })
    const { key } = (await claimed.json()) as { key: string }
    const owner = { authorization: `Bearer ${key}` }
    const made = await first.send('/api/upstreams', {
      method: 'POST',
      headers: owner,
      body: { id: 'sample', kind: 'sample', title: 'Sample tools', auth: { type: 'none' } },
    })
    expect(made.status).toBe(201)
    expect((await made.json()).toolCount).toBe(3)
    const ran = await first.send('/api/calls', {
      method: 'POST',
      headers: owner,
      body: { tool: 'sample.roll_dice', arguments: { count: 3, sides: 6 } },
    })
    const result = (await ran.json()).result.structuredContent as { rolls: number[]; total: number }
    expect(result.rolls).toHaveLength(3)
    expect(result.total).toBe(result.rolls.reduce((sum, roll) => sum + roll, 0))
    const groups = (await (await first.send('/api/upstreams/sample/groups', { headers: owner })).json()) as {
      effects: { effect: string; tools: number }[]
    }
    expect(groups.effects.find((entry) => entry.effect === 'reads')?.tools).toBe(3)
  })
})
