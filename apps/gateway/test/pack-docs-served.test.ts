/**
 * A pack's own playbooks and its skill, as the pack's keys get them: over REST, as MCP prompts and through
 * `get_playbook`, in search hints, as a skill, and in the pack's guide. The pack lock holds at each: a key reads only
 * what was written for the pack its request is locked to.
 */
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-served-docs'
const upstream = await startUpstream({ token: 'fixture-token', greeting: true })
const db = await testDb()
const app = await createApp({
  db,
  env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
})
afterAll(() => upstream.close())

type Init = { method?: string; body?: unknown; headers?: Record<string, string> }
/** An answer with its text, with a key. */
const at = async (key: string, path: string, init: Init = {}) => {
  const response = await app.request(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const text = await response.text()
  const json = (() => {
    try {
      return JSON.parse(text) as any
    } catch {
      return null
    }
  })()
  return { status: response.status, text, json }
}
const owner = (path: string, init?: Init) => at(OWNER, path, init)
type Made = { id: string; key: string }
const keyFor = async (body: Record<string, unknown>) => {
  const made = await owner('/api/clients', { method: 'POST', body: { scope: 'write', ...body } })
  expect([made.status, made.json?.detail]).toEqual([201, undefined])
  return made.json as Made
}
const packWith = async (name: string, title: string, tools: Record<string, unknown>[]) => {
  const made = await owner('/api/packs', {
    method: 'POST',
    body: { name, title, description: `${title}: says things to people.` },
  })
  expect([name, made.status, made.json?.detail]).toEqual([name, 201, undefined])
  const added = await owner(`/api/packs/${name}`, { method: 'PATCH', body: { add: { tools } } })
  expect([name, added.status, added.json?.detail]).toEqual([name, 200, undefined])
}
const write = async (pack: string, name: string, markdown: string) => {
  const saved = await owner(`/api/packs/${pack}/playbooks`, { method: 'POST', body: { name, markdown } })
  expect([pack, name, saved.status, saved.json?.detail]).toEqual([pack, name, 201, undefined])
}
const skillOf = async (pack: string, markdown: string) => {
  const saved = await owner(`/api/packs/${pack}/skill`, { method: 'PUT', body: { markdown } })
  expect([pack, saved.status, saved.json?.detail]).toEqual([pack, 200, undefined])
}
const variables = async (pack: string, set: Record<string, string>) => {
  const saved = await owner(`/api/packs/${pack}/variables`, {
    method: 'PUT',
    body: { variables: Object.entries(set).map(([name, value]) => ({ name, value })) },
  })
  expect([pack, saved.status, saved.json?.detail]).toEqual([pack, 200, undefined])
}

const SAY_HELLO = `---
title: Say hello
description: Greets a guest by name, from the desk.
arguments:
  - name: guest
    description: Who to greet.
    required: true
  - name: mood
---

1. Run \`greet_from_desk\` with \`to\` set to {{guest}}, at {{door}}.
2. Say it back with \`fixture.echo\`, sounding {{mood}}.
`
const SHOUT_IT = `---
title: Shout it
description: Says a line twice, the second time louder.
---

1. Run \`fixture.echo\` with the line.
2. Run \`fixture.shout\` with the same line.
`
/** A skill in its six sections; `about` is what it is for, `tools` the line that names them. */
const skillText = (about: string, tools: string) =>
  [
    '## What it is for',
    about,
    '## Which tool for which job',
    tools,
    '## Values already set',
    'Nothing to set.',
    '## Playbooks',
    'See the list.',
    '## Gotchas',
    '```sh\n# not a heading\n```',
    '## What it can’t do',
    'It can’t send mail.',
  ].join('\n\n')

/** The names of a list of playbooks, tools or prompts. */
const namesOf = (items: { name: string }[]) => items.map((item) => item.name)
const playbooksAt = async (key: string, path = '/api/playbooks') =>
  (await at(key, path)).json._embedded.playbooks as { name: string; upstream: string | null; pack: string | null }[]
/** A playbook filled in over REST: its status and its text, or the refusal. */
const filled = async (key: string, path: string, args?: Record<string, string>) => {
  const answer = await at(
    key,
    `${path}/messages${args ? `?arguments=${encodeURIComponent(JSON.stringify(args))}` : ''}`,
  )
  return {
    status: answer.status,
    detail: answer.json?.detail,
    json: answer.json,
    text: answer.json?.messages?.[0]?.content?.text,
  }
}
const hintsAt = async (key: string, path: string) =>
  (await at(key, path)).json.playbooks as { name: string; title: string; description: string }[]
const skillAt = (key: string, base: string, pack: string) =>
  at(key, `${base}/resources?uri=${encodeURIComponent(`skill://${pack}/SKILL.md`)}`)
const logged = async (id: string) => {
  const { json } = await owner(`/api/calls/${id}`)
  return { kind: json.kind, tool: json.tool, upstream: json.upstream, status: json.status, via: json.via }
}

let ada: Made
let sam: Made
let both: Made
let plain: Made

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
  await packWith('desk', 'Front desk', [
    { name: 'fixture.greet', alias: 'greet_from_desk', fixed: { from: 'the desk' } },
    { name: 'fixture.echo' },
  ])
  const held = await owner('/api/packs/desk', { method: 'PATCH', body: { add: { playbooks: ['fixture-warm-up'] } } })
  expect([held.status, held.json?.detail]).toEqual([200, undefined])
  await variables('desk', { door: 'the front door' })
  await write('desk', 'say-hello', SAY_HELLO)
  await skillOf(
    'desk',
    skillText('Greeting people at {{door}}.', '`greet_from_desk` greets; `fixture.echo` says it back.'),
  )
  await packWith('loud', 'Loud', [{ name: 'fixture.echo' }, { name: 'fixture.shout' }])
  await write('loud', 'shout-it', SHOUT_IT)
  await skillOf('loud', skillText('Saying things loudly.', '`fixture.shout` shouts; `fixture.echo` says it back.'))
  ada = await keyFor({ name: 'Ada', pack: 'desk' })
  sam = await keyFor({ name: 'Sam', pack: 'loud' })
  both = await keyFor({ name: 'Ada and Sam', packs: ['desk', 'loud'] })
  plain = await keyFor({ name: 'Script', upstreams: 'all' })
})

describe('the lock on a pack key', () => {
  it('names the playbooks written for its pack and where its skill is read', async () => {
    expect((await at(ada.key, '/api/me')).json.pack).toMatchObject({
      name: 'desk',
      playbooks: ['fixture-warm-up'],
      ownPlaybooks: ['say-hello'],
      skill: 'skill://desk/SKILL.md',
    })
    expect((await at(sam.key, '/p/loud/api/me')).json.pack).toMatchObject({
      name: 'loud',
      ownPlaybooks: ['shout-it'],
      skill: 'skill://loud/SKILL.md',
    })
  })

  it('follows the address for a key that opens two packs, and names none outside packs', async () => {
    expect((await at(both.key, '/p/desk/api/me')).json.pack.ownPlaybooks).toEqual(['say-hello'])
    expect((await at(both.key, '/p/loud/api/me')).json.pack).toMatchObject({
      ownPlaybooks: ['shout-it'],
      skill: 'skill://loud/SKILL.md',
    })
    expect((await at(plain.key, '/api/me')).json.pack).toBeNull()
    expect((await owner('/api/me')).json.pack).toBeNull()
    // The owner at a pack's address is held to that pack's lock
    expect((await owner('/p/desk/api/me')).json.pack).toMatchObject({ ownPlaybooks: ['say-hello'] })
  })

  it('names none for a pack that wrote none', async () => {
    await packWith('quiet', 'Quiet', [{ name: 'fixture.echo' }])
    const key = await keyFor({ name: 'Quiet key', pack: 'quiet' })
    expect((await at(key.key, '/api/me')).json.pack).toMatchObject({ ownPlaybooks: [], skill: null })
  })
})

describe('a pack’s own playbooks over REST', () => {
  it('are listed first, each as a playbook of the pack and of no connection', async () => {
    const listed = await at(ada.key, '/p/desk/api/playbooks')
    expect(listed.json.count).toBe(2)
    expect(namesOf(listed.json._embedded.playbooks)).toEqual(['say-hello', 'fixture-warm-up'])
    const [own, held] = listed.json._embedded.playbooks
    expect(own).toEqual({
      name: 'say-hello',
      upstream: null,
      pack: 'desk',
      prompt: 'say-hello',
      title: 'Front desk · Say hello',
      description: 'Greets a guest by name, from the desk.',
      arguments: [
        { name: 'guest', description: 'Who to greet.', required: true },
        { name: 'mood', description: null, required: false },
      ],
      offered: true,
      _links: { self: { href: 'http://localhost/p/desk/api/playbooks/say-hello' } },
    })
    expect(held).toMatchObject({ name: 'fixture-warm-up', upstream: 'fixture', pack: null })
    expect((await at(ada.key, '/p/desk/api/playbooks/say-hello')).json).toEqual(own)
  })

  it('are left out when one connection is asked for, and kept within the limit', async () => {
    expect(namesOf(await playbooksAt(ada.key, '/p/desk/api/playbooks?upstream=fixture'))).toEqual(['fixture-warm-up'])
    expect(namesOf(await playbooksAt(ada.key, '/p/desk/api/playbooks?limit=1'))).toEqual(['say-hello'])
  })

  it('are found by what they do', async () => {
    expect(namesOf(await playbooksAt(ada.key, '/p/desk/api/playbooks?q=greet+a+guest'))).toEqual(['say-hello'])
    expect(namesOf(await playbooksAt(ada.key, '/p/desk/api/playbooks?q=check+the+server'))).toEqual(['fixture-warm-up'])
    expect(await playbooksAt(ada.key, '/p/desk/api/playbooks?q=greet+a+guest&upstream=fixture')).toEqual([])
  })

  it('are filled in with the arguments given and the pack’s variables, and logged as a read', async () => {
    const read = await filled(ada.key, '/p/desk/api/playbooks/say-hello', { guest: 'Sam', mood: 'glad' })
    expect([read.status, read.detail]).toEqual([200, undefined])
    expect(read.json).toMatchObject({
      name: 'say-hello',
      description: 'Greets a guest by name, from the desk.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: '1. Run `greet_from_desk` with `to` set to Sam, at the front door.\n2. Say it back with `fixture.echo`, sounding glad.\n',
          },
        },
      ],
    })
    expect(new URL(read.json._links.playbook.href).pathname).toBe('/p/desk/api/playbooks/say-hello')
    expect(await logged(read.json.callId)).toEqual({
      kind: 'playbook',
      tool: 'say-hello',
      upstream: null,
      status: 'ok',
      via: 'rest',
    })
    // An argument left out is filled with nothing
    expect((await filled(ada.key, '/api/playbooks/say-hello', { guest: 'Sam' })).text).toContain('sounding .')
  })

  it('refuse a use that leaves a required argument out, naming it', async () => {
    const read = await filled(ada.key, '/api/playbooks/say-hello', { mood: 'glad' })
    expect([read.status, read.detail]).toEqual([400, 'say-hello needs guest: guest (Who to greet.); mood.'])
    expect((await filled(ada.key, '/api/playbooks/say-hello')).status).toBe(400)
  })

  it('read a variable as it is now', async () => {
    await variables('desk', { door: 'the side door' })
    expect((await filled(ada.key, '/api/playbooks/say-hello', { guest: 'Sam' })).text).toContain('at the side door.')
    await variables('desk', { door: 'the front door' })
    expect((await filled(ada.key, '/api/playbooks/say-hello', { guest: 'Sam' })).text).toContain('at the front door.')
  })

  it('are suggested by a search for what they do, first', async () => {
    expect(await hintsAt(ada.key, '/p/desk/api/tools?q=greet+a+guest')).toEqual([
      {
        name: 'say-hello',
        title: 'Front desk · Say hello',
        description: 'Greets a guest by name, from the desk.',
      },
    ])
    expect(await hintsAt(ada.key, '/p/desk/api/tools?q=greet+a+guest&upstream=fixture')).toEqual([])
    // The owner, searching as the pack's keys do
    expect(namesOf(await hintsAt(OWNER, '/api/tools?q=greet+a+guest&pack=desk'))).toEqual(['say-hello'])
  })

  it('count on no connection', async () => {
    const [fixture] = (await at(ada.key, '/p/desk/api/upstreams')).json._embedded.upstreams
    expect([fixture.id, fixture.offers.playbooks]).toEqual(['fixture', 1])
  })
})

describe('a pack’s skill over REST', () => {
  it('is read at its address, whole, with the pack’s variables filled in, and logged as a manual read', async () => {
    const read = await skillAt(ada.key, '/p/desk/api', 'desk')
    expect([read.status, read.json?.detail]).toEqual([200, undefined])
    expect(read.json).toMatchObject({ uri: 'skill://desk/SKILL.md', upstream: null })
    const [part] = read.json.contents
    expect(part).toMatchObject({ uri: 'skill://desk/SKILL.md', mimeType: 'text/markdown', blob: null })
    expect(part.text).toMatch(
      /^---\nname: desk\ndescription: "Working with Front desk: Front desk: says things to people\."\n---\n\n# Working with Front desk\n\n## What it is for\n\nGreeting people at the front door\.\n/,
    )
    expect(await logged(read.json.callId)).toEqual({
      kind: 'manual',
      tool: 'skill://desk/SKILL.md',
      upstream: null,
      status: 'ok',
      via: 'rest',
    })
  })

  it('reads a variable as it is now', async () => {
    await variables('desk', { door: 'the side door' })
    expect((await skillAt(ada.key, '/api', 'desk')).json.contents[0].text).toContain('at the side door.')
    await variables('desk', { door: 'the front door' })
  })

  it('is only its SKILL.md: nothing else is under its address', async () => {
    const other = await at(ada.key, `/api/resources?uri=${encodeURIComponent('skill://desk/references/notes.md')}`)
    expect(other.status).toBe(404)
  })
})

describe('the pack lock, for what is written for a pack', () => {
  it('gives a key nothing written for another pack: by name, in lists, in hints, or as a skill', async () => {
    expect(namesOf(await playbooksAt(sam.key))).toEqual(['shout-it'])
    expect((await at(sam.key, '/api/playbooks/say-hello')).status).toBe(404)
    const read = await filled(sam.key, '/p/loud/api/playbooks/say-hello', { guest: 'Sam' })
    expect([read.status, read.detail]).toEqual([
      404,
      'No playbook say-hello for this client. GET /api/playbooks?q=<what you want to do> finds yours.',
    ])
    expect(await hintsAt(sam.key, '/api/tools?q=greet+a+guest')).toEqual([])
    expect(namesOf(await hintsAt(sam.key, '/api/tools?q=say+a+line+louder'))).toEqual(['shout-it'])
    const skill = await skillAt(sam.key, '/api', 'desk')
    expect(skill.status).toBe(404)
    expect(skill.text).not.toContain('front door')
    // Its own is its own
    expect((await skillAt(sam.key, '/api', 'loud')).json.contents[0].text).toContain('Saying things loudly.')
    expect((await skillAt(ada.key, '/api', 'loud')).status).toBe(404)
  })

  it('gives a key outside packs, and the owner at the root, none of them', async () => {
    for (const key of [plain.key, OWNER]) {
      const names = namesOf(await playbooksAt(key))
      expect(names).toEqual(expect.arrayContaining(['fixture-warm-up']))
      expect(names.filter((name) => !name.startsWith('fixture-'))).toEqual([])
      expect((await at(key, '/api/playbooks/say-hello')).status).toBe(404)
      expect((await filled(key, '/api/playbooks/say-hello', { guest: 'Sam' })).status).toBe(404)
      expect(await playbooksAt(key, '/api/playbooks?q=greet+a+guest')).toEqual([])
      expect((await skillAt(key, '/api', 'desk')).status).toBe(404)
      expect((await at(key, '/api/tools?q=greet+a+guest')).json.playbooks).toEqual([])
    }
  })

  it('holds the owner at a pack’s address to that pack', async () => {
    expect(namesOf(await playbooksAt(OWNER, '/p/desk/api/playbooks'))).toEqual(['say-hello', 'fixture-warm-up'])
    expect(namesOf(await playbooksAt(OWNER, '/p/loud/api/playbooks'))).toEqual(['shout-it'])
    expect((await at(OWNER, '/p/loud/api/playbooks/say-hello')).status).toBe(404)
    expect((await skillAt(OWNER, '/p/loud/api', 'desk')).status).toBe(404)
    expect((await skillAt(OWNER, '/p/loud/api', 'loud')).status).toBe(200)
  })

  it('gives a key that opens two packs each pack’s own only at that pack’s address', async () => {
    expect(namesOf(await playbooksAt(both.key, '/p/desk/api/playbooks'))).toEqual(['say-hello', 'fixture-warm-up'])
    expect(namesOf(await playbooksAt(both.key, '/p/loud/api/playbooks'))).toEqual(['shout-it'])
    expect((await at(both.key, '/p/desk/api/playbooks/shout-it')).status).toBe(404)
    expect((await filled(both.key, '/p/loud/api/playbooks/say-hello', { guest: 'Sam' })).status).toBe(404)
    expect((await skillAt(both.key, '/p/desk/api', 'loud')).status).toBe(404)
    expect((await skillAt(both.key, '/p/loud/api', 'loud')).status).toBe(200)
    // By the header, as by the address
    const byHeader = await at(both.key, '/api/playbooks', { headers: { 'x-gateway-pack': 'loud' } })
    expect(namesOf(byHeader.json._embedded.playbooks)).toEqual(['shout-it'])
  })

  it('gives a key whose pack was removed none, even beside a pack named removed', async () => {
    await packWith('shed', 'Shed', [{ name: 'fixture.echo' }])
    await write('shed', 'shout-it', SHOUT_IT.replace('`fixture.shout`', '`fixture.echo`'))
    await skillOf('shed', skillText('Kept in the shed.', '`fixture.echo` says it back.'))
    const key = await keyFor({ name: 'Shed key', pack: 'shed', expiresIn: '8h' })
    expect(namesOf(await playbooksAt(key.key))).toEqual(['shout-it'])
    // A pack with a live key can't be removed: its key ends, the pack goes, the key is extended
    await db.run(sql`update clients set expires_at = ${new Date(Date.now() - 1000).toISOString()} where id = ${key.id}`)
    expect((await owner('/api/packs/shed', { method: 'DELETE' })).status).toBe(204)
    expect((await owner(`/api/clients/${key.id}`, { method: 'PATCH', body: { expiresIn: '7d' } })).status).toBe(200)
    await packWith('removed', 'Removed', [{ name: 'fixture.echo' }])
    await write('removed', 'shout-it', SHOUT_IT.replace('`fixture.shout`', '`fixture.echo`'))
    await skillOf('removed', skillText('Not the shed.', '`fixture.echo` says it back.'))

    const me = (await at(key.key, '/api/me')).json
    expect(me.pack).toMatchObject({ name: 'removed', ownPlaybooks: [], skill: null })
    expect(await playbooksAt(key.key)).toEqual([])
    expect((await at(key.key, '/api/playbooks/shout-it')).status).toBe(404)
    expect((await filled(key.key, '/api/playbooks/shout-it')).status).toBe(404)
    expect((await skillAt(key.key, '/api', 'removed')).status).toBe(404)
    expect((await skillAt(key.key, '/api', 'shed')).status).toBe(404)
  })
})

describe('a renamed pack', () => {
  let old: Made
  beforeAll(async () => {
    await packWith('porch', 'Porch', [{ name: 'fixture.echo' }])
    await write('porch', 'say-it', SHOUT_IT.replace('`fixture.shout`', '`fixture.echo`').replace('Shout it', 'Say it'))
    await skillOf('porch', skillText('Talking on the porch.', '`fixture.echo` says it back.'))
    old = await keyFor({ name: 'Porch key', pack: 'porch' })
    const renamed = await owner('/api/packs/porch', { method: 'PATCH', body: { name: 'veranda' } })
    expect([renamed.status, renamed.json?.detail]).toEqual([200, undefined])
  })

  it('serves what was written for it at its old address, by the name it has now', async () => {
    for (const base of ['/p/porch/api', '/p/veranda/api']) {
      const listed = await playbooksAt(old.key, `${base}/playbooks`)
      expect([base, listed.map((playbook) => [playbook.name, playbook.pack])]).toEqual([base, [['say-it', 'veranda']]])
      expect([base, (await filled(old.key, `${base}/playbooks/say-it`)).status]).toEqual([base, 200])
      expect((await at(old.key, `${base}/me`)).json.pack.skill).toBe('skill://veranda/SKILL.md')
      const skill = await skillAt(old.key, base, 'veranda')
      expect([base, skill.status, skill.json?.contents[0].text.includes('Talking on the porch.')]).toEqual([
        base,
        200,
        true,
      ])
    }
    const byHeader = await at(old.key, '/api/playbooks', { headers: { 'x-gateway-pack': 'porch' } })
    expect(namesOf(byHeader.json._embedded.playbooks)).toEqual(['say-it'])
    // The skill moved with the pack's name: its old address leads nowhere
    expect((await skillAt(old.key, '/p/porch/api', 'porch')).status).toBe(404)
  })

  it('tells a key that does not open it nothing at the old address', async () => {
    for (const path of ['/p/porch/api/playbooks', '/p/porch/api/playbooks/say-it', '/p/porch/api/me']) {
      const refused = await at(sam.key, path)
      expect([path, refused.status]).toEqual([path, 403])
      expect(refused.text).not.toContain('veranda')
      expect(refused.text).not.toContain('say-it')
    }
    const skill = await at(sam.key, `/p/porch/api/resources?uri=${encodeURIComponent('skill://veranda/SKILL.md')}`)
    expect(skill.status).toBe(403)
    expect(skill.text).not.toContain('Talking on the porch')
    // And from its own pack, the renamed pack's texts are no more its own than any other's
    expect((await at(sam.key, '/api/playbooks/say-it')).status).toBe(404)
    expect((await skillAt(sam.key, '/api', 'veranda')).status).toBe(404)
    expect((await skillAt(sam.key, '/api', 'porch')).status).toBe(404)
  })
})

describe('changing a pack’s variables', () => {
  it('tells connected agents their tools, prompts and resources changed', async () => {
    const seen: unknown[] = []
    const stop = app.services.events.subscribe((event) => {
      if (event.type === 'lists') seen.push(event.data)
    })
    await variables('desk', { door: 'the front door' })
    stop()
    expect(seen).toEqual([{ tools: true, prompts: true, resources: true }])
  })
})
