/**
 * A pack's own playbooks and its skill: Markdown the owner (or an agent of theirs) writes for the pack, kept in the
 * gateway with every version, and checked on every save. Nothing here reaches a pack key yet.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-pack-docs'
const upstream = await startUpstream({ token: 'fixture-token', greeting: true })
const gateway = async () =>
  createApp({
    db: await testDb(),
    env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
  })
const app = await gateway()
afterAll(() => upstream.close())

type App = Awaited<ReturnType<typeof gateway>>
type Init = { method?: string; body?: unknown }
const asking =
  (on: App) =>
  async (key: string, path: string, init: Init = {}) => {
    const response = await on.request(path, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    return {
      status: response.status,
      location: response.headers.get('location'),
      json: (await response.json().catch(() => null)) as any,
    }
  }
const api = asking(app)
const owner = (path: string, init?: Init) => api(OWNER, path, init)
const connect = (
  ask: (path: string, init?: Init) => Promise<{ status: number }>,
  id: string,
  url: string,
  token = 'fixture-token',
) =>
  ask('/api/upstreams', {
    method: 'POST',
    body: { id, title: id, url, trust: 'review', auth: { type: 'bearer', value: token } },
  })
const packWith = async (name: string, title: string, tools: Record<string, unknown>[]) => {
  await owner('/api/packs', { method: 'POST', body: { name, title, description: `${title}: greets people.` } })
  const added = await owner(`/api/packs/${name}`, { method: 'PATCH', body: { add: { tools } } })
  expect([name, added.status, added.json?.detail]).toEqual([name, 200, undefined])
}
const write = (pack: string, name: string, markdown: string) =>
  owner(`/api/packs/${pack}/playbooks`, { method: 'POST', body: { name, markdown } })
const codes = (findings: { level: string; code: string }[]) => findings.map((finding) => [finding.level, finding.code])

const SAY_HELLO = `---
title: Say hello
description: Greets a guest by name, from the desk.
arguments:
  - name: guest
    description: Who to greet.
    required: true
---

1. Run \`greet_from_desk\` with \`to\` set to {{guest}}, at {{door}}.
2. Say it back with \`fixture.echo\`.
`
const SKILL = [
  '## What it is for',
  'Greeting people at {{door}}.',
  '## Which tool for which job',
  '`greet_from_desk` greets; `fixture.echo` says it back.',
  '## Values already set',
  'The greeting is always from the desk.',
  '## Playbooks',
  '`say-hello` greets one guest.',
  '## Gotchas',
  'None yet.',
  '## What it can’t do',
  'It can’t send mail.',
].join('\n\n')

beforeAll(async () => {
  expect((await connect(owner, 'fixture', upstream.url)).status).toBe(201)
  await packWith('desk', 'Front desk', [
    { name: 'fixture.greet', alias: 'greet_from_desk', fixed: { from: 'the desk' } },
    { name: 'fixture.echo' },
    { name: 'fixture.shout' },
  ])
  const set = await owner('/api/packs/desk/variables', {
    method: 'PUT',
    body: { variables: [{ name: 'door', value: 'the front door' }] },
  })
  expect(set.status).toBe(200)
})

describe('writing a pack’s playbooks', () => {
  it('saves a playbook, read from its front matter and checked', async () => {
    const made = await write('desk', 'say-hello', SAY_HELLO)
    expect([made.status, made.location]).toEqual([201, '/api/packs/desk/playbooks/say-hello'])
    expect(made.json).toMatchObject({
      name: 'say-hello',
      title: 'Say hello',
      description: 'Greets a guest by name, from the desk.',
      arguments: [{ name: 'guest', description: 'Who to greet.', required: true }],
      steps: 2,
      flag: null,
      findings: [],
      markdown: SAY_HELLO,
      versions: [{ id: made.json.version, source: 'owner', live: true, createdAt: expect.any(String) }],
    })
    expect(made.json._links.self.href).toMatch(/\/api\/packs\/desk\/playbooks\/say-hello$/)
  })

  it('shows it on the pack, beside the playbooks the pack holds from its connections', async () => {
    const pack = (await owner('/api/packs/desk')).json
    expect(pack.counts).toMatchObject({ playbooks: 0, ownPlaybooks: 1 })
    expect(pack.ownPlaybooks).toEqual([
      {
        name: 'say-hello',
        title: 'Say hello',
        description: 'Greets a guest by name, from the desk.',
        arguments: [{ name: 'guest', description: 'Who to greet.', required: true }],
        steps: 2,
        flag: null,
        findings: [],
      },
    ])
    expect(pack.skill).toBeNull()
    // A variable a playbook writes is in use
    expect(pack.findings).toEqual([])
    const listed = (await owner('/api/packs/desk/playbooks')).json
    expect([listed.count, listed._embedded.playbooks.map((playbook: { name: string }) => playbook.name)]).toEqual([
      1,
      ['say-hello'],
    ])
    expect((await owner('/api/packs/desk/playbooks/say-hello')).json.markdown).toBe(SAY_HELLO)
  })

  it('refuses a name the pack already has a playbook under, and a name that is no name', async () => {
    const again = await write('desk', 'say-hello', 'Greet them.')
    expect(again.status).toBe(409)
    expect(again.json.detail).toBe(
      'Front desk already has a playbook called say-hello: PUT /api/packs/desk/playbooks/say-hello replaces its text.',
    )
    expect((await write('desk', 'Say_Hello', 'Greet them.')).status).toBe(400)
  })

  it('refuses a save with everything wrong in the text, each with its place', async () => {
    const bad = await write(
      'desk',
      'say-bye',
      'Run `fixture.greet` for {{guest}}, then `fixture.whisper`. Find more with `greet_desk`.',
    )
    expect(bad.status).toBe(400)
    expect(bad.json.detail).toBe(
      'Not saved: {{guest}} is neither an argument of this playbook nor a variable of Front desk: declare one, or take it out; `fixture.greet` is called `greet_from_desk` in Front desk: write that; `fixture.whisper` is not in Front desk: add it to the pack, or take it out of the text.',
    )
    expect(bad.json.errors.map((error: { path: string }) => error.path)).toEqual([
      'playbooks.say-bye',
      'playbooks.say-bye',
      'playbooks.say-bye',
    ])
    expect((await owner('/api/packs/desk/playbooks/say-bye')).status).toBe(404)
  })

  it('saves with warnings, and says them', async () => {
    const made = await write('desk', 'say-bye', 'Run `fixture.shout`, then `greet_desk`.')
    expect(made.status).toBe(201)
    expect(made.json.findings).toEqual([
      {
        level: 'warning',
        code: 'needs_write',
        path: 'playbooks.say-bye',
        message: '`fixture.shout` changes things: a read-only key can’t run it.',
      },
      {
        level: 'warning',
        code: 'unknown_name',
        path: 'playbooks.say-bye',
        message: '`greet_desk` is not a tool of Front desk. If it is meant as one, check the name.',
      },
    ])
    expect(made.json.title).toBe('Say bye')
    const pack = (await owner('/api/packs/desk')).json
    expect(codes(pack.findings)).toEqual([
      ['warning', 'needs_write'],
      ['warning', 'unknown_name'],
    ])
    expect(pack.ownPlaybooks.map((playbook: { name: string }) => playbook.name)).toEqual(['say-hello', 'say-bye'])
  })

  it('replaces a playbook’s text, and only one that is there', async () => {
    const replaced = await owner('/api/packs/desk/playbooks/say-bye', {
      method: 'PUT',
      body: { markdown: '---\ntitle: Wave\n---\nSay goodbye with `fixture.echo`.' },
    })
    expect([replaced.status, replaced.json.title, replaced.json.findings]).toEqual([200, 'Wave', []])
    const missing = await owner('/api/packs/desk/playbooks/say-nothing', { method: 'PUT', body: { markdown: 'Hm.' } })
    expect(missing.status).toBe(404)
    expect(missing.json.detail).toBe(
      'Front desk has no playbook of its own called say-nothing. GET /api/packs/desk/playbooks lists them; POST there makes one.',
    )
    const refused = await owner('/api/packs/desk/playbooks/say-bye', {
      method: 'PUT',
      body: { markdown: 'Ask {{nobody}}.' },
    })
    expect(refused.status).toBe(400)
    expect((await owner('/api/packs/desk/playbooks/say-bye')).json.title).toBe('Wave')
  })

  it('removes a playbook', async () => {
    expect((await owner('/api/packs/desk/playbooks/say-bye', { method: 'DELETE' })).status).toBe(204)
    expect((await owner('/api/packs/desk/playbooks/say-bye', { method: 'DELETE' })).status).toBe(404)
    expect((await owner('/api/packs/desk')).json.counts.ownPlaybooks).toBe(1)
  })
})

describe('writing a pack’s skill', () => {
  it('has none until one is written', async () => {
    const none = await owner('/api/packs/desk/skill')
    expect(none.status).toBe(404)
    expect(none.json.detail).toBe('Front desk has no skill yet: PUT /api/packs/desk/skill writes it.')
  })

  it('saves the text, and writes the front matter and the heading itself', async () => {
    const saved = await owner('/api/packs/desk/skill', {
      method: 'PUT',
      body: { markdown: `---\nname: something-else\n---\n\n# My heading\n\n${SKILL}` },
    })
    expect(saved.status).toBe(200)
    expect(saved.json).toMatchObject({
      uri: 'skill://desk/SKILL.md',
      sections: [
        'What it is for',
        'Which tool for which job',
        'Values already set',
        'Playbooks',
        'Gotchas',
        "What it can't do",
      ],
      flag: null,
      findings: [],
      markdown: SKILL,
      versions: [{ id: saved.json.version, source: 'owner', live: true }],
    })
    expect(saved.json.served).toBe(
      [
        '---',
        'name: desk',
        'description: "Working with Front desk: Front desk: greets people."',
        '---',
        '',
        '# Working with Front desk',
        '',
        SKILL.replace('{{door}}', 'the front door'),
      ].join('\n'),
    )
    expect((await owner('/api/packs/desk')).json.skill).toEqual({
      uri: 'skill://desk/SKILL.md',
      sections: saved.json.sections,
      flag: null,
      findings: [],
    })
  })

  it('warns about a section it lacks and refuses a word that is no variable', async () => {
    const short = await owner('/api/packs/desk/skill', {
      method: 'PUT',
      body: { markdown: SKILL.replace('## Gotchas\n\nNone yet.\n\n', '') },
    })
    expect([short.status, short.json.findings]).toEqual([
      200,
      [
        {
          level: 'warning',
          code: 'missing_section',
          path: 'skill',
          message: 'no section Gotchas: add each as a `## ` heading.',
        },
      ],
    ])
    const bad = await owner('/api/packs/desk/skill', { method: 'PUT', body: { markdown: 'Greet {{guest}}.' } })
    expect([bad.status, bad.json.detail]).toEqual([
      400,
      'Not saved: {{guest}} is no variable of Front desk: declare it, or take it out.',
    ])
    const empty = await owner('/api/packs/desk/skill', { method: 'PUT', body: { markdown: '# Only a heading\n' } })
    expect([empty.status, empty.json.detail]).toEqual([
      400,
      'Not saved: nothing is left of the skill once its front matter and first heading are taken off, which the gateway writes itself. Send the text under them.',
    ])
  })

  it('removes the skill', async () => {
    expect((await owner('/api/packs/desk/skill', { method: 'DELETE' })).status).toBe(204)
    expect((await owner('/api/packs/desk/skill', { method: 'DELETE' })).status).toBe(404)
    expect((await owner('/api/packs/desk')).json.skill).toBeNull()
  })
})

describe('who may write them', () => {
  it('is the owner only: a client key and a request at the pack’s own address are refused', async () => {
    const made = await owner('/api/clients', { method: 'POST', body: { name: 'desk-agent', pack: 'desk' } })
    const paths: [string, Init][] = [
      ['/api/packs/desk/playbooks', {}],
      ['/api/packs/desk/playbooks', { method: 'POST', body: { name: 'say-hi', markdown: 'Hi.' } }],
      ['/api/packs/desk/playbooks/say-hello', {}],
      ['/api/packs/desk/playbooks/say-hello', { method: 'PUT', body: { markdown: 'Hi.' } }],
      ['/api/packs/desk/playbooks/say-hello', { method: 'DELETE' }],
      ['/api/packs/desk/skill', {}],
      ['/api/packs/desk/skill', { method: 'PUT', body: { markdown: 'Hi.' } }],
      ['/api/packs/desk/skill', { method: 'DELETE' }],
      ['/api/packs/desk/checks', { method: 'POST', body: { kind: 'skill', markdown: 'Hi.' } }],
    ]
    for (const [path, init] of paths) {
      expect([path, init.method ?? 'GET', (await api(made.json.key, path, init)).status]).toEqual([
        path,
        init.method ?? 'GET',
        403,
      ])
      expect([path, init.method ?? 'GET', (await owner(`/p/desk${path}`, init)).status]).toEqual([
        path,
        init.method ?? 'GET',
        403,
      ])
    }
    expect((await owner('/api/packs/desk/playbooks/say-hello')).json.markdown).toBe(SAY_HELLO)
  })
})

describe('checking a draft', () => {
  it('says what a save would, and saves nothing', async () => {
    const draft = await owner('/api/packs/desk/checks', {
      method: 'POST',
      body: { kind: 'playbook', name: 'say-hi', markdown: 'Run `fixture.greet`, then `fixture.shout`.' },
    })
    expect(draft.status).toBe(200)
    expect(draft.json.findings).toEqual([
      {
        level: 'error',
        code: 'use_alias',
        path: 'playbooks.say-hi',
        message: '`fixture.greet` is called `greet_from_desk` in Front desk: write that.',
      },
      {
        level: 'warning',
        code: 'needs_write',
        path: 'playbooks.say-hi',
        message: '`fixture.shout` changes things: a read-only key can’t run it.',
      },
    ])
    expect((await owner('/api/packs/desk/playbooks/say-hi')).status).toBe(404)
    const unnamed = await owner('/api/packs/desk/checks', {
      method: 'POST',
      body: { kind: 'playbook', markdown: 'Ask {{nobody}}.' },
    })
    expect(
      unnamed.json.findings.map((finding: { code: string; path: string }) => [finding.code, finding.path]),
    ).toEqual([['unresolved', 'playbooks.draft']])
    const skill = await owner('/api/packs/desk/checks', { method: 'POST', body: { kind: 'skill', markdown: SKILL } })
    expect(skill.json.findings).toEqual([])
    expect((await owner('/api/packs/desk/skill')).status).toBe(404)
    expect((await owner('/api/packs/desk')).json.counts.ownPlaybooks).toBe(1)
  })
})

describe('versions', () => {
  it('keeps every text a playbook had: a changed save adds one, the same text adds none', async () => {
    const first = (await owner('/api/packs/desk/playbooks/say-hello')).json
    const changed = SAY_HELLO.replace('Say it back', 'Then say it back')
    const second = await owner('/api/packs/desk/playbooks/say-hello', { method: 'PUT', body: { markdown: changed } })
    const same = await owner('/api/packs/desk/playbooks/say-hello', { method: 'PUT', body: { markdown: changed } })
    expect(second.json.version).not.toBe(first.version)
    expect(same.json.version).toBe(second.json.version)
    expect(same.json.versions.map((version: { id: string; live: boolean }) => [version.id, version.live])).toEqual([
      [second.json.version, true],
      [first.version, false],
    ])
    const old = await owner(`/api/packs/desk/playbooks/say-hello?version=${first.version}`)
    expect([old.status, old.json.version, old.json.markdown]).toEqual([200, first.version, SAY_HELLO])
    expect((await owner('/api/packs/desk/playbooks/say-hello')).json.markdown).toBe(changed)
    const none = await owner('/api/packs/desk/playbooks/say-hello?version=pdv_nothing')
    expect([none.status, none.json.detail]).toEqual([
      404,
      'say-hello has no version pdv_nothing. GET /api/packs/desk/playbooks/say-hello lists its versions.',
    ])
  })

  it('keeps the skill’s versions the same way, comparing the text it stores', async () => {
    const first = await owner('/api/packs/desk/skill', { method: 'PUT', body: { markdown: SKILL } })
    const same = await owner('/api/packs/desk/skill', {
      method: 'PUT',
      body: { markdown: first.json.served.replace('the front door', '{{door}}') },
    })
    expect(same.json.version).toBe(first.json.version)
    const second = await owner('/api/packs/desk/skill', { method: 'PUT', body: { markdown: `${SKILL}\n\nMore.` } })
    expect(second.json.versions).toHaveLength(2)
    const old = await owner(`/api/packs/desk/skill?version=${first.json.version}`)
    expect([old.json.version, old.json.markdown]).toEqual([first.json.version, SKILL])
    // A version is read only as a version of its own document
    expect((await owner(`/api/packs/desk/playbooks/say-hello?version=${first.json.version}`)).status).toBe(404)
  })
})

describe('what a document holds a pack to', () => {
  it('refuses removing a variable a playbook still writes, naming the playbook', async () => {
    const removed = await owner('/api/packs/desk/variables', { method: 'PUT', body: { variables: [] } })
    expect([removed.status, removed.json.detail]).toEqual([
      400,
      'Not saved: {{door}} is still used by the playbook say-hello, the skill: change that first, or keep the variable.',
    ])
    expect(removed.json.errors).toEqual([
      {
        in: 'body',
        path: 'variables.door',
        message:
          '{{door}} is still used by the playbook say-hello, the skill: change that first, or keep the variable.',
      },
    ])
  })

  it('refuses adding a connection’s playbook named like one of the pack’s own', async () => {
    expect((await write('desk', 'fixture-say-it-back', 'Say it back with `fixture.echo`.')).status).toBe(201)
    const added = await owner('/api/packs/desk', {
      method: 'PATCH',
      body: { add: { playbooks: ['fixture-say-it-back'] } },
    })
    expect([added.status, added.json.detail]).toEqual([
      400,
      'Front desk already has its own playbook called fixture-say-it-back: rename that one first.',
    ])
    expect((await owner('/api/packs/desk')).json.playbooks).toEqual([])
    expect((await owner('/api/packs/desk/playbooks/fixture-say-it-back', { method: 'DELETE' })).status).toBe(204)
  })

  it('goes with its pack when the pack is removed', async () => {
    await packWith('brief', 'Brief', [{ name: 'fixture.echo' }])
    expect((await write('brief', 'say-it', 'Say it with `fixture.echo`.')).status).toBe(201)
    expect((await owner('/api/packs/brief', { method: 'DELETE' })).status).toBe(204)
    await packWith('brief', 'Brief', [{ name: 'fixture.echo' }])
    expect((await owner('/api/packs/brief')).json.ownPlaybooks).toEqual([])
    expect((await owner('/api/packs/brief', { method: 'DELETE' })).status).toBe(204)
  })
})

describe('a flag when a tool changes under a text', () => {
  const flagsOf = async (pack: string) =>
    (await owner('/api/packs/flags')).json._embedded.flags.filter((flag: { pack: string }) => flag.pack === pack)

  it('flags the playbooks and the skill written for a tool its server has since rewritten', async () => {
    expect((await owner('/api/packs/desk')).json.flags).toBe(0)
    upstream.state.echoDescription = 'Says the text back, word for word.'
    await owner('/api/upstreams/fixture/sync', { method: 'POST' })
    const pending = (await owner('/api/reviews')).json._embedded.reviews.find(
      (review: { name: string }) => review.name === 'fixture.echo',
    )
    // Until the owner approves the change, the text still stands on the live tool
    expect((await owner('/api/packs/desk')).json.flags).toBe(0)
    await owner(`/api/reviews/${pending.versionId}`, { method: 'POST', body: { decision: 'approve' } })

    const flag = {
      was: 'written for fixture.echo',
      now: 'fixture.echo now reads: Says the text back, word for word.',
    }
    const pack = (await owner('/api/packs/desk')).json
    expect(pack.flags).toBe(2)
    expect(pack.ownPlaybooks[0]).toMatchObject({ name: 'say-hello', flag, findings: [] })
    expect(pack.skill.flag).toEqual(flag)
    expect((await owner('/api/packs')).json._embedded.packs[0]).toMatchObject({ name: 'desk', flags: 2 })
    expect(await flagsOf('desk')).toEqual([
      {
        kind: 'playbook',
        pack: 'desk',
        packTitle: 'Front desk',
        tool: 'fixture.echo',
        item: 'say-hello',
        wording: '',
        ...flag,
        _links: {
          pack: { href: expect.stringMatching(/\/api\/packs\/desk$/) },
          tool: { href: expect.stringMatching(/\/api\/tools\/fixture\.echo$/) },
        },
      },
      expect.objectContaining({ kind: 'skill', item: 'SKILL.md', tool: 'fixture.echo', ...flag }),
    ])
  })

  it('clears the flag when the same text is saved again, without a new version', async () => {
    const before = (await owner('/api/packs/desk/playbooks/say-hello')).json
    const kept = await owner('/api/packs/desk/playbooks/say-hello', {
      method: 'PUT',
      body: { markdown: before.markdown },
    })
    expect([kept.status, kept.json.flag, kept.json.version, kept.json.versions.length]).toEqual([
      200,
      null,
      before.version,
      before.versions.length,
    ])
    expect((await flagsOf('desk')).map((flag: { kind: string }) => flag.kind)).toEqual(['skill'])
    const skill = (await owner('/api/packs/desk/skill')).json
    expect(
      (await owner('/api/packs/desk/skill', { method: 'PUT', body: { markdown: skill.markdown } })).json.flag,
    ).toBeNull()
    expect(await flagsOf('desk')).toEqual([])
  })
})

describe('a tool that leaves the pack under a text', () => {
  const extra = { close: async () => {} }
  const playbookOf = async (name: string) =>
    (await owner('/api/packs/lobby')).json.ownPlaybooks.find((playbook: { name: string }) => playbook.name === name)
  /** Saving the text as it is: refused while it names what the pack no longer has. */
  const savedAgain = async (name: string) => {
    const { markdown } = (await owner(`/api/packs/lobby/playbooks/${name}`)).json
    const saved = await owner(`/api/packs/lobby/playbooks/${name}`, { method: 'PUT', body: { markdown } })
    return [saved.status, saved.json.detail ?? null]
  }
  beforeAll(async () => {
    const second = await startUpstream({ token: 'extra-token' })
    extra.close = second.close
    expect((await connect(owner, 'extra', second.url, 'extra-token')).status).toBe(201)
    await packWith('lobby', 'Lobby', [
      { name: 'fixture.greet', alias: 'greet_from_lobby' },
      { name: 'fixture.echo' },
      { name: 'extra.echo' },
    ])
    expect((await write('lobby', 'by-alias', 'Run `greet_from_lobby`.')).status).toBe(201)
    expect((await write('lobby', 'by-name', 'Run `fixture.echo`.')).status).toBe(201)
    expect((await write('lobby', 'by-extra', 'Run `extra.echo`.')).status).toBe(201)
  })
  afterAll(() => extra.close())

  it('renames a tool a playbook names by its alias: the rename goes through and the playbook is flagged', async () => {
    const renamed = await owner('/api/packs/lobby/tools/greet_from_lobby', {
      method: 'PATCH',
      body: { alias: 'greet_lobby' },
    })
    expect([renamed.status, renamed.json.name]).toEqual([200, 'greet_lobby'])
    const pack = (await owner('/api/packs/lobby')).json
    expect(pack.flags).toBe(1)
    expect(await playbookOf('by-alias')).toMatchObject({
      flag: { was: 'written for greet_from_lobby', now: 'greet_from_lobby is no longer in Lobby' },
      findings: [
        {
          level: 'error',
          code: 'left_pack',
          path: 'playbooks.by-alias',
          message:
            '`greet_from_lobby` is no longer a tool of Lobby: write the name it has now, or take it out of the text.',
        },
      ],
    })
    // The name leads to no tool any more, so the flag links only to the pack
    const [flag] = (await owner('/api/packs/flags')).json._embedded.flags.filter(
      (row: { pack: string }) => row.pack === 'lobby',
    )
    expect(flag).toMatchObject({ kind: 'playbook', item: 'by-alias', tool: 'greet_from_lobby' })
    expect(Object.keys(flag._links)).toEqual(['pack'])
  })

  it('never lets a flagged playbook block another, and refuses the flagged one until its text is fixed', async () => {
    expect((await write('lobby', 'another', 'Run `greet_lobby`.')).status).toBe(201)
    expect(await savedAgain('another')).toEqual([200, null])
    expect(await savedAgain('by-alias')).toEqual([
      400,
      'Not saved: `greet_from_lobby` is no longer a tool of Lobby: write the name it has now, or take it out of the text.',
    ])
    const fixed = await owner('/api/packs/lobby/playbooks/by-alias', {
      method: 'PUT',
      body: { markdown: 'Run `greet_lobby`.' },
    })
    expect([fixed.status, fixed.json.flag, fixed.json.findings]).toEqual([200, null, []])
  })

  it('gives an alias to a tool a playbook names by its own name: flagged, and told the alias', async () => {
    const aliased = await owner('/api/packs/lobby/tools/fixture.echo', { method: 'PATCH', body: { alias: 'say_back' } })
    expect(aliased.status).toBe(200)
    expect(await playbookOf('by-name')).toMatchObject({
      flag: { was: 'written for fixture.echo', now: 'fixture.echo is no longer in Lobby' },
      findings: [expect.objectContaining({ level: 'error', code: 'use_alias' })],
    })
    expect(await savedAgain('by-name')).toEqual([
      400,
      'Not saved: `fixture.echo` is called `say_back` in Lobby: write that.',
    ])
  })

  it('removes that tool from the pack: the answer lists what the playbook now gets wrong', async () => {
    const removed = await owner('/api/packs/lobby', { method: 'PATCH', body: { remove: { tools: ['say_back'] } } })
    expect(removed.status).toBe(200)
    expect(removed.json.findings).toContainEqual({
      level: 'error',
      code: 'not_in_pack',
      path: 'playbooks.by-name',
      message: '`fixture.echo` is not in Lobby: add it to the pack, or take it out of the text.',
    })
    expect((await playbookOf('by-name')).flag).toEqual({
      was: 'written for fixture.echo',
      now: 'fixture.echo is no longer in Lobby',
    })
    expect(await savedAgain('another')).toEqual([200, null])
    expect(await savedAgain('by-name')).toEqual([
      400,
      'Not saved: `fixture.echo` is not in Lobby: add it to the pack, or take it out of the text.',
    ])
  })

  it('removes a connection a playbook names a tool of: flagged, and refused until its text is fixed', async () => {
    expect((await owner('/api/upstreams/extra', { method: 'DELETE' })).status).toBe(204)
    expect(await playbookOf('by-extra')).toMatchObject({
      flag: { was: 'written for extra.echo', now: 'extra.echo is no longer in Lobby' },
      findings: [expect.objectContaining({ level: 'error', code: 'left_pack' })],
    })
    expect((await owner('/api/packs/lobby')).json.flags).toBe(2)
    expect(await savedAgain('another')).toEqual([200, null])
    expect(await savedAgain('by-extra')).toEqual([
      400,
      'Not saved: `extra.echo` is no longer a tool of Lobby: write the name it has now, or take it out of the text.',
    ])
  })
})

describe('in the config', () => {
  const HELLO =
    '---\ntitle: Say hello\narguments:\n  - name: guest\n---\n\n1. Run `greet_from_porch` for {{guest}}, from {{who}}.\n'
  /** A pack without what differs between two gateways: ids, dates, links and keys. */
  const comparable = (pack: Record<string, unknown>) => {
    const { _links, createdAt, updatedAt, triedAt, lastCallAt, keys, keyList, ...rest } = pack
    return rest
  }
  let exported: any

  beforeAll(async () => {
    await packWith('porch', 'Porch', [
      { name: 'fixture.greet', alias: 'greet_from_porch', fixed: { from: '{{who}}' } },
      { name: 'fixture.echo' },
    ])
    await owner('/api/packs/porch/variables', {
      method: 'PUT',
      body: { variables: [{ name: 'who', value: 'the porch' }] },
    })
    const held = await owner('/api/packs/porch', {
      method: 'PATCH',
      body: { add: { playbooks: ['fixture-say-it-back'], manuals: ['fixture'] } },
    })
    expect(held.status).toBe(200)
    expect((await write('porch', 'say-hello', HELLO)).status).toBe(201)
    expect((await write('porch', 'say-back', 'Say it back with `fixture.echo`.')).status).toBe(201)
    expect(
      (
        await owner('/api/packs/porch/skill', {
          method: 'PUT',
          body: { markdown: SKILL.replaceAll('greet_from_desk', 'greet_from_porch').replace('{{door}}', '{{who}}') },
        })
      ).status,
    ).toBe(200)
    exported = (await owner('/api/config')).json
  })

  it('leaves as plain Markdown files, one per playbook and one for the skill', async () => {
    const porch = exported.packs.find((pack: { name: string }) => pack.name === 'porch')
    expect(Object.keys(porch.files)).toEqual(['playbooks/say-hello.md', 'playbooks/say-back.md', 'SKILL.md'])
    expect(porch.files['playbooks/say-hello.md']).toBe(HELLO)
    // The skill as it is read, its variables left as written
    expect(porch.files['SKILL.md']).toBe(
      (await owner('/api/packs/porch/skill')).json.served.replace('the porch', '{{who}}'),
    )
  })

  it('comes back the same on a fresh gateway, once its tools are in', async () => {
    const fresh = await gateway()
    const there = (path: string, init?: Init) => asking(fresh)(OWNER, path, init)
    const config = { ...exported, packs: exported.packs.filter((pack: { name: string }) => pack.name === 'porch') }

    // The connection waits for its credential: the pack comes in without tools, and its texts wait for them
    const first = (await there('/api/config', { method: 'POST', body: config })).json
    expect(first.packs).toEqual({ created: ['porch'], filled: [] })
    expect(first.skipped).toEqual(
      expect.arrayContaining([
        'pack porch tool greet_from_porch: not live yet',
        'pack porch playbooks/say-hello.md: names greet_from_porch, which is not in the pack yet (import again once its tools are in)',
        'pack porch playbooks/say-back.md: names fixture.echo, which is not in the pack yet (import again once its tools are in)',
        'pack porch SKILL.md: names greet_from_porch, fixture.echo, which are not in the pack yet (import again once its tools are in)',
      ]),
    )
    expect((await there('/api/packs/porch')).json).toMatchObject({ ownPlaybooks: [], skill: null })

    await there('/api/upstreams/fixture', {
      method: 'PATCH',
      body: { auth: { type: 'bearer', value: 'fixture-token' } },
    })
    const second = (await there('/api/config', { method: 'POST', body: config })).json
    expect(second.packs).toEqual({ created: [], filled: ['porch'] })
    expect(second.skipped.filter((line: string) => line.startsWith('pack'))).toEqual([])

    const here = (await owner('/api/packs/porch')).json
    const back = (await there('/api/packs/porch')).json
    expect(comparable(back)).toEqual(comparable(here))
    expect(back.ownPlaybooks.map((playbook: { name: string }) => playbook.name)).toEqual(['say-hello', 'say-back'])
    expect((await there('/api/packs/porch/playbooks/say-hello')).json).toMatchObject({
      markdown: HELLO,
      versions: [{ source: 'import', live: true }],
    })
    expect((await there('/api/packs/porch/skill')).json.markdown).toBe(
      (await owner('/api/packs/porch/skill')).json.markdown,
    )

    // Again changes nothing: a text the pack has is kept as it is
    const third = (await there('/api/config', { method: 'POST', body: config })).json
    expect(third.packs).toEqual({ created: [], filled: [] })
    expect((await there('/api/packs/porch/playbooks/say-hello')).json.versions).toHaveLength(1)
    expect((await there('/api/config')).json.packs[0].files).toEqual(config.packs[0].files)
  })

  it('skips a connection’s playbook named like one the pack wrote itself', async () => {
    await packWith('stoop', 'Stoop', [{ name: 'fixture.echo' }])
    expect((await write('stoop', 'fixture-say-it-back', 'Say it back with `fixture.echo`.')).status).toBe(201)
    const sent = await owner('/api/config', {
      method: 'POST',
      body: { packs: [{ name: 'stoop', title: 'Stoop', playbooks: ['fixture-say-it-back', 'fixture-warm-up'] }] },
    })
    expect(sent.json.skipped).toEqual([
      'pack stoop playbook fixture-say-it-back: the pack has a playbook of its own called that (rename that one first)',
    ])
    const stoop = (await owner('/api/packs/stoop')).json
    expect(stoop.playbooks.map((item: { name: string }) => item.name)).toEqual(['fixture-warm-up'])
    expect(stoop.findings).toEqual([])
  })

  it('skips a file that is no playbook or skill, and a text the checks refuse, saying why', async () => {
    const fresh = await gateway()
    const there = (path: string, init?: Init) => asking(fresh)(OWNER, path, init)
    const sent = await there('/api/config', {
      method: 'POST',
      body: {
        packs: [
          {
            name: 'porch',
            title: 'Porch',
            files: {
              'notes/todo.md': 'Later.',
              'playbooks/Say_Hello.md': 'Greet.',
              'playbooks/say-hello.md': 'Greet {{guest}}.',
              'playbooks/say-bye.md': 'Wave.',
            },
          },
        ],
      },
    })
    expect(sent.status).toBe(200)
    expect(sent.json.skipped).toEqual([
      'pack porch notes/todo.md: not a file a pack holds (SKILL.md, or playbooks/<name>.md)',
      'pack porch playbooks/Say_Hello.md: Say_Hello is not a playbook name: start with a lowercase letter, then lowercase letters, digits or - (3 to 64), like find-roles',
      'pack porch playbooks/say-hello.md: {{guest}} is neither an argument of this playbook nor a variable of Porch: declare one, or take it out.',
    ])
    expect(
      (await there('/api/packs/porch')).json.ownPlaybooks.map((playbook: { name: string }) => playbook.name),
    ).toEqual(['say-bye'])
  })
})
