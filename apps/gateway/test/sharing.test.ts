/**
 * Sharing a pack with key-based apps: how long a key works, moving its end, and what its holder and the owner are
 * told once it has ended.
 */
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-sharing'
const upstream = await startUpstream({ token: 'fixture-token' })
const db = await testDb()
const app = await createApp({
  db,
  env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
})
afterAll(async () => {
  await upstream.close()
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
type Made = { id: string; key: string; app: string | null; expiresAt: string | null }
const keyFor = async (body: Record<string, unknown>) => {
  const made = await owner('/api/clients', { method: 'POST', body: { scope: 'write', ...body } })
  expect(made.status).toBe(201)
  return made.json as Made
}
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** How far from now a time is, to the minute. */
const fromNow = (iso: string | null) => Math.round((Date.parse(iso ?? '') - Date.now()) / 60_000) * 60_000

/** Ends a key a moment ago, as time would. */
const end = (id: string) =>
  db.run(sql`update clients set expires_at = ${new Date(Date.now() - 1000).toISOString()} where id = ${id}`)
const extend = (id: string, expiresIn: string) => owner(`/api/clients/${id}`, { method: 'PATCH', body: { expiresIn } })

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
  for (const [name, title] of [
    ['loud', 'Loud'],
    ['desk', 'Desk'],
  ]) {
    const made = await owner('/api/packs', {
      method: 'POST',
      body: { name, title, description: 'Say things back.', playbook: 'fixture-say-it-back' },
    })
    expect(made.json.counts).toEqual({ tools: 2, playbooks: 1, manuals: 1 })
  }
})

describe('how long a key works', () => {
  it('takes 30 days, beside 8 hours, a day and a week', async () => {
    for (const [expiresIn, ms] of [
      ['8h', 8 * HOUR],
      ['1d', DAY],
      ['7d', 7 * DAY],
      ['30d', 30 * DAY],
    ] as const)
      expect([
        expiresIn,
        fromNow((await keyFor({ name: `for ${expiresIn}`, pack: 'loud', expiresIn })).expiresAt),
      ]).toEqual([expiresIn, ms])
    expect((await keyFor({ name: 'for good', pack: 'loud', expiresIn: 'never' })).expiresAt).toBeNull()
    expect((await keyFor({ name: 'unsaid', pack: 'loud' })).expiresAt).toBeNull()
    const refused = await owner('/api/clients', {
      method: 'POST',
      body: { name: 'a season', pack: 'loud', expiresIn: '90d' },
    })
    expect(refused.status).toBe(400)
  })
})

describe('Extend', () => {
  it('counts from today and brings an ended key back', async () => {
    const sam = await keyFor({ name: 'Sam', pack: 'loud', expiresIn: '8h' })
    await end(sam.id)
    expect((await api(sam.key, '/p/loud/api/me')).status).toBe(403)
    const week = await extend(sam.id, '7d')
    expect(week.status).toBe(200)
    expect(fromNow(week.json.expiresAt)).toBe(7 * DAY)
    // The same key: the person changes nothing
    expect((await api(sam.key, '/p/loud/api/me')).status).toBe(200)
    expect(fromNow((await extend(sam.id, '30d')).json.expiresAt)).toBe(30 * DAY)
    expect((await extend(sam.id, 'never')).json.expiresAt).toBeNull()
  })

  it('leaves the end alone when a change says nothing about it', async () => {
    const sam = await keyFor({ name: 'Sam', pack: 'loud', expiresIn: '7d' })
    const renamed = await owner(`/api/clients/${sam.id}`, { method: 'PATCH', body: { name: 'Sam at the desk' } })
    expect(renamed.json).toMatchObject({ name: 'Sam at the desk', expiresAt: sam.expiresAt })
  })

  it('never moves an end to a day or less', async () => {
    const sam = await keyFor({ name: 'Sam', pack: 'loud', expiresIn: '8h' })
    for (const expiresIn of ['8h', '1d']) {
      const refused = await extend(sam.id, expiresIn)
      expect([expiresIn, refused.status]).toEqual([expiresIn, 400])
      expect(JSON.stringify(refused.json.errors)).toContain('expiresIn')
    }
    expect((await owner(`/api/clients/${sam.id}`)).json.expiresAt).toBe(sam.expiresAt)
  })

  it('does not bring a revoked key back', async () => {
    const sam = await keyFor({ name: 'Sam', pack: 'loud', expiresIn: '7d' })
    await owner(`/api/clients/${sam.id}`, { method: 'DELETE' })
    expect((await extend(sam.id, '30d')).status).toBe(410)
    expect((await api(sam.key, '/p/loud/api/me')).status).toBe(401)
  })
})

describe('where a key runs', () => {
  it('is kept as the owner said it, or not at all', async () => {
    const said = await keyFor({ name: 'Ada', pack: 'loud', app: 'cursor' })
    expect(said.app).toBe('cursor')
    expect((await owner(`/api/clients/${said.id}`)).json.app).toBe('cursor')
    expect((await keyFor({ name: 'Ada', pack: 'loud' })).app).toBeNull()
    const exported = (await owner('/api/config')).json.clients as { id: string; app: string | null }[]
    expect(exported.find((client) => client.id === said.id)?.app).toBe('cursor')
  })

  it('is never claude.ai, which signs in and takes no key', async () => {
    const refused = await owner('/api/clients', {
      method: 'POST',
      body: { name: 'Ada', pack: 'loud', app: 'claude-ai' },
    })
    expect(refused.status).toBe(400)
    expect(JSON.stringify(refused.json.errors)).toContain('app')
  })
})
