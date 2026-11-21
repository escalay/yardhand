/**
 * Sharing a pack with key-based apps: how long a key works, moving its end, and what its holder and the owner are
 * told once it has ended.
 */
import { randomBytes } from 'node:crypto'
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
