/**
 * A pack's own playbooks and its skill, as the pack's keys get them: over REST, as MCP prompts and through
 * `get_playbook`, in search hints, as a skill, and in the pack's guide. The pack lock holds at each: a key reads only
 * what was written for the pack its request is locked to.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-served-docs'
const upstream = await startUpstream({ token: 'fixture-token', greeting: true })
const app = await createApp({
  db: await testDb(),
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
      playbooks: [],
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
