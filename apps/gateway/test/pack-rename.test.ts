/**
 * Renaming a pack: its address moves, and while it has keys the old name keeps leading to it. No other pack can take
 * that name until the owner frees it or the pack goes.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { dayOf } from '../src/features/clients/lifetimes.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-renaming'
const upstream = await startUpstream({ token: 'fixture-token' })
const db = await testDb()
const app = await createApp({
  db,
  env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
})
afterAll(() => upstream.close())

type Init = { method?: string; body?: unknown; headers?: Record<string, string> }
/** An answer with its headers, with a key or (null) without credentials. Nothing follows a redirect here. */
const at = async (key: string | null, path: string, init: Init = {}) => {
  const response = await app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      'content-type': 'application/json',
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  return { status: response.status, headers: response.headers, json: (await response.json().catch(() => null)) as any }
}
const owner = (path: string, init?: Init) => at(OWNER, path, init)
type Made = { id: string; key: string }
const keyFor = async (body: Record<string, unknown>) => {
  const made = await owner('/api/clients', { method: 'POST', body: { scope: 'write', ...body } })
  expect(made.status).toBe(201)
  return made.json as Made
}
const packOf = async (name: string, title: string) => {
  const made = await owner('/api/packs', {
    method: 'POST',
    body: { name, title, description: `What ${title} is for.` },
  })
  expect(made.status).toBe(201)
  const filled = await owner(`/api/packs/${name}`, {
    method: 'PATCH',
    body: { add: { tools: [{ name: 'fixture.echo' }, { name: 'fixture.shout' }] } },
  })
  expect(filled.json.counts.tools).toBe(2)
}
const rename = (from: string, to: string) => owner(`/api/packs/${from}`, { method: 'PATCH', body: { name: to } })
const formerOf = async (name: string) =>
  ((await owner(`/api/packs/${name}`)).json.formerNames as { name: string; until: string; people: number }[]).map(
    ({ name: former, people }) => ({ name: former, people }),
  )
const namesOf = (items: { name: string }[]) => items.map((item) => item.name)
const unknown = (name: string) => `No pack ${name}. GET /api/packs lists them.`
const renamed = (from: string, to: string) => `No pack ${from}: it was renamed to ${to}. GET /api/packs/${to}.`

let sam: Made
let both: Made

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
  await packOf('shed', 'Garden')
  await packOf('desk', 'Desk')
  sam = await keyFor({ name: 'Sam', pack: 'shed' })
  both = await keyFor({ name: 'Sam at work', packs: ['shed', 'desk'] })
})

describe('renaming a pack', () => {
  it('moves it to its new address and lists the name it had', async () => {
    const moved = await rename('shed', 'garden')
    expect(moved.status).toBe(200)
    expect(moved.json).toMatchObject({ name: 'garden', title: 'Garden', counts: { tools: 2 }, keys: 2 })
    expect(new URL(moved.json._links.self.href).pathname).toBe('/api/packs/garden')
    expect(moved.json.formerNames).toEqual([{ name: 'shed', until: expect.any(String), people: 0 }])
    expect(dayOf(moved.json.formerNames[0].until)).toBe(dayOf(new Date().toISOString()))
    expect((await owner('/api/packs/garden')).status).toBe(200)
    expect((await owner('/api/packs/shed')).status).toBe(404)
    expect(namesOf((await owner('/api/packs')).json._embedded.packs)).toEqual(['desk', 'garden'])
    // Its keys are its keys under any name
    for (const made of [sam, both])
      expect((await owner(`/api/clients/${made.id}`)).json.packs).toEqual(expect.arrayContaining(['garden']))
    expect((await at(sam.key, '/api/packs/garden', { method: 'PATCH', body: { name: 'mine' } })).status).toBe(403)
  })

  it('keeps the old name from every later pack: a new one, a renamed one, an imported one', async () => {
    const until = dayOf(new Date().toISOString())
    const taken = `shed still leads to Garden (its name until ${until}), so the people who connect there are not cut off: pick another name, or free it with DELETE /api/packs/garden/names/shed.`
    const made = await owner('/api/packs', { method: 'POST', body: { name: 'shed', title: 'Shed' } })
    expect([made.status, made.json.detail]).toEqual([409, taken])
    const moved = await rename('desk', 'shed')
    expect([moved.status, moved.json.detail]).toEqual([409, taken])
    expect((await owner('/api/packs/desk')).status).toBe(200)
    // A name a pack has now is refused as before
    const same = await rename('desk', 'garden')
    expect([same.status, same.json.detail]).toEqual([409, 'A pack is already named garden: pick another name.'])
    const imported = await owner('/api/config', {
      method: 'POST',
      body: { packs: [{ name: 'shed', title: 'Shed', tools: [{ name: 'fixture.echo' }] }] },
    })
    expect(imported.status).toBe(200)
    expect(imported.json.packs).toEqual({ created: [], filled: [] })
    expect(imported.json.skipped).toEqual([
      'pack shed: the name still leads to garden (free it with DELETE /api/packs/garden/names/shed)',
    ])
    expect(namesOf((await owner('/api/packs')).json._embedded.packs)).toEqual(['desk', 'garden'])
  })

  it('changes nothing when the rest of the change cannot be made', async () => {
    const refused = await owner('/api/packs/garden', {
      method: 'PATCH',
      body: { name: 'plot', title: 'Plot', add: { tools: [{ name: 'fixture.nope' }] } },
    })
    expect(refused.status).toBe(400)
    expect(refused.json.detail).toContain('Not live, so not added: fixture.nope')
    const still = await owner('/api/packs/garden')
    expect([still.status, still.json.title]).toEqual([200, 'Garden'])
    expect(await formerOf('garden')).toEqual([{ name: 'shed', people: 0 }])
    expect((await owner('/api/packs/plot')).json.detail).toBe(unknown('plot'))
    // Its own name again is no rename, and a name with the rest of a change is one change
    expect((await rename('garden', 'garden')).status).toBe(200)
    expect(await formerOf('garden')).toEqual([{ name: 'shed', people: 0 }])
    const whole = await owner('/api/packs/desk', { method: 'PATCH', body: { name: 'bureau', title: 'Bureau' } })
    expect(whole.json).toMatchObject({ name: 'bureau', title: 'Bureau', formerNames: [{ name: 'desk' }] })
    expect((await rename('bureau', 'desk')).json).toMatchObject({ name: 'desk', formerNames: [{ name: 'bureau' }] })
  })

  it('tells the owner where it went, wherever a pack is named', async () => {
    const moved = renamed('shed', 'garden')
    for (const path of [
      '/api/packs/shed',
      '/api/packs/shed/setup',
      '/api/calls?pack=shed',
      '/api/searches?pack=shed',
      '/api/overview/stats?pack=shed',
      '/api/tools?pack=shed',
      '/api/tools/fixture.echo?pack=shed',
      '/api/playbooks/fixture-say-it-back/uses?pack=shed',
    ]) {
      const old = await owner(path)
      expect([path, old.status, old.json.detail]).toEqual([path, 404, moved])
      const never = await owner(path.replace('shed', 'nope'))
      expect([path, never.status, never.json.detail]).toEqual([path, 404, unknown('nope')])
    }
    const changed = await owner('/api/packs/shed', { method: 'PATCH', body: { title: 'Shed' } })
    expect([changed.status, changed.json.detail]).toEqual([404, moved])
    const made = await owner('/api/clients', { method: 'POST', body: { name: 'late', pack: 'shed' } })
    expect([made.status, made.json.detail]).toEqual([400, moved])
    const never = await owner('/api/clients', { method: 'POST', body: { name: 'late', pack: 'nope' } })
    expect([never.status, never.json.detail]).toEqual([400, unknown('nope')])
    // One sentence per name that is not there
    const repacked = await owner(`/api/clients/${both.id}`, {
      method: 'PATCH',
      body: { packs: ['shed', 'desk', 'nope'] },
    })
    expect([repacked.status, repacked.json.detail]).toEqual([400, `${moved} ${unknown('nope')}`])
    // A key is told nothing of the kind: these are the owner's routes
    const asked = await at(sam.key, '/api/packs/shed')
    expect(asked.status).toBe(403)
    expect(JSON.stringify(asked.json)).not.toContain('garden')
  })

  it('takes a name off the list when the pack goes back to it', async () => {
    await packOf('yard', 'Yard')
    await keyFor({ name: 'Sam in the yard', pack: 'yard' })
    expect(await rename('yard', 'lawn').then((moved) => moved.json.formerNames)).toEqual([
      expect.objectContaining({ name: 'yard' }),
    ])
    expect((await rename('lawn', 'yard')).status).toBe(200)
    expect(await formerOf('yard')).toEqual([{ name: 'lawn', people: 0 }])
    // Every name it had leads to it, newest first
    expect((await rename('yard', 'meadow')).status).toBe(200)
    expect(await formerOf('meadow')).toEqual([
      { name: 'yard', people: 0 },
      { name: 'lawn', people: 0 },
    ])
  })

  it('frees an old name when the owner says so, for another pack to take', async () => {
    const missing = await owner('/api/packs/meadow/names/plot', { method: 'DELETE' })
    expect([missing.status, missing.json.detail]).toEqual([
      404,
      'Yard has no old name plot. GET /api/packs/meadow lists them.',
    ])
    // Another pack's old name is not this one's to free
    expect((await owner('/api/packs/meadow/names/shed', { method: 'DELETE' })).status).toBe(404)
    expect((await at(sam.key, '/api/packs/meadow/names/lawn', { method: 'DELETE' })).status).toBe(403)
    expect((await owner('/api/packs/meadow/names/lawn', { method: 'DELETE' })).status).toBe(204)
    const again = await owner('/api/packs/meadow/names/lawn', { method: 'DELETE' })
    expect([again.status, again.json.detail]).toEqual([
      404,
      'Yard has no old name lawn. GET /api/packs/meadow lists them.',
    ])
    expect(await formerOf('meadow')).toEqual([{ name: 'yard', people: 0 }])
    expect((await owner('/api/packs', { method: 'POST', body: { name: 'lawn', title: 'Lawn' } })).status).toBe(201)
    expect((await owner('/api/packs', { method: 'POST', body: { name: 'yard', title: 'Yard' } })).status).toBe(409)
  })

  it('keeps none for a pack nobody has a key to, or only revoked ones', async () => {
    await packOf('bare', 'Bare')
    expect((await rename('bare', 'bald')).json.formerNames).toEqual([])
    expect((await owner('/api/packs/bare')).json.detail).toBe(unknown('bare'))
    const gone = await keyFor({ name: 'Ada, once', pack: 'bald' })
    expect((await owner(`/api/clients/${gone.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await rename('bald', 'bare')).json.formerNames).toEqual([])
    // So the name is free at once
    expect((await owner('/api/packs', { method: 'POST', body: { name: 'bald', title: 'Bald' } })).status).toBe(201)
  })

  it('frees a pack’s old names when the pack is removed', async () => {
    await packOf('hut', 'Hut')
    const reader = await keyFor({ name: 'Sam in the hut', pack: 'hut' })
    expect((await rename('hut', 'cabin')).json.formerNames).toEqual([expect.objectContaining({ name: 'hut' })])
    expect((await owner(`/api/clients/${reader.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await owner('/api/packs/cabin', { method: 'DELETE' })).status).toBe(204)
    expect((await owner('/api/packs/hut')).json.detail).toBe(unknown('hut'))
    expect((await owner('/api/packs', { method: 'POST', body: { name: 'hut', title: 'Hut' } })).status).toBe(201)
    expect((await owner('/api/packs/hut')).json.formerNames).toEqual([])
  })
})
