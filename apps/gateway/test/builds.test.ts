/**
 * Build with AI against a scripted model: a build drafts a pack, rehearses each task with the pack's read-only tools,
 * and keeps one sealed proposal the owner accepts line by line. Each group of cases builds its own pack and sends at
 * most six `POST …/builds` to it, so the hourly limit per pack is never met by accident.
 */
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import type { Ask } from '../src/features/ai/model.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { fakeModel } from './fixtures/model.js'
import { startUpstream } from './fixtures/upstream.js'

const OWNER = 'owner-key-for-builds'
const upstream = await startUpstream({ token: 'fixture-token', asking: true, greeting: true })
afterAll(() => upstream.close())

type Init = { method?: string; body?: unknown; headers?: Record<string, string> }
const gateway = async (model: ReturnType<typeof fakeModel>) => {
  const db = await testDb()
  const app = await createApp({
    db,
    env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
    model,
  })
  const api = async (path: string, init: Init = {}, key = OWNER) => {
    const response = await app.request(path, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    return {
      status: response.status,
      location: response.headers.get('location'),
      json: (await response.json().catch(() => null)) as any,
    }
  }
  const connected = await api('/api/upstreams', {
    method: 'POST',
    body: {
      id: 'fixture',
      title: 'Fixture',
      url: upstream.url,
      trust: 'trusted',
      auth: { type: 'bearer', value: 'fixture-token' },
    },
  })
  expect(connected.status).toBe(201)
  const pack = async (name: string, title: string, description: string, tools: string[] = []) => {
    expect((await api('/api/packs', { method: 'POST', body: { name, title, description } })).status).toBe(201)
    if (tools.length)
      expect(
        (
          await api(`/api/packs/${name}`, {
            method: 'PATCH',
            body: { add: { tools: tools.map((tool) => ({ name: tool, reason: 'picked' })) } },
          })
        ).status,
      ).toBe(200)
  }
  /** Starts a build and waits until it is no longer running. */
  const build = async (name: string, tasks: string[], mode: 'build' | 'refresh' = 'build') => {
    const started = await api(`/api/packs/${name}/builds`, { method: 'POST', body: { mode, tasks } })
    expect([started.status, started.json?.detail]).toEqual([202, undefined])
    expect(started.location).toBe(`/api/packs/${name}/builds/${started.json.id}`)
    return settled(name, started.json.id)
  }
  const settled = async (name: string, id: string) => {
    for (let tries = 0; tries < 250; tries++) {
      const got = await api(`/api/packs/${name}/builds/${id}`)
      if (got.json.status !== 'running') return got.json
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`build ${id} still running`)
  }
  return { app, db, api, pack, build, settled }
}

const GREET_GUEST = `---
title: Greet a guest
description: Greets a guest by name, from the desk.
arguments:
  - name: guest
    description: Who to greet.
    required: true
---

1. Run \`fixture.greet\` with \`to\` set to {{guest}}; it greets from {{desk_name}}.
2. Say it back with \`fixture.echo\`.
`
const ECHO_NOTE = `---
title: Echo a note
description: Says a note back.
---

1. Run \`fixture.echo\` with the note.
`

/** A model that drafts a desk: two tools, a variable the greeting is fixed to, a playbook a task, a skill. */
const deskModel = (extra: Parameters<typeof fakeModel>[0] = {}) =>
  fakeModel({
    kit: {
      tools: [
        { name: 'fixture.greet', reason: 'Greets the guest.', wording: 'Greets a guest from the desk.' },
        { name: 'fixture.echo', reason: 'Says a note back.' },
        { name: 'fixture.whisper', reason: 'Whispers to the guest.' },
        { name: 'elsewhere.send_mail', reason: 'Tells the guest.' },
      ],
      skipped: [{ name: 'fixture.shout', reason: 'Nothing here needs shouting.' }],
      variables: [{ name: 'desk_name', value: 'the front desk', description: 'Who greets.' }],
      inputs: [{ tool: 'fixture.greet', input: 'from', mode: 'fixed', value: '{{desk_name}}' }],
    },
    playbook: (ask: Ask) =>
      said(ask).task.includes('greet')
        ? { name: 'greet-guest', markdown: GREET_GUEST }
        : { name: 'echo-note', markdown: ECHO_NOTE },
    rehearse: (ask: Ask) =>
      said(ask).task.includes('greet') && !said(ask).steps.length
        ? {
            tool: 'fixture.greet',
            arguments: { to: 'Ada', ...(said(ask).task.includes('boss') ? { from: 'the boss' } : {}) },
          }
        : { done: true, outcome: 'Greeted Ada from the front desk.' },
    ...extra,
  })
const TASKS = ['greet a guest called Ada', 'echo a note back']
/** What an ask sent the model. */
const said = (ask: Ask) => JSON.parse(ask.user) as { task: string; steps: unknown[] }

describe('a build', async () => {
  const model = deskModel()
  const { api, pack, build } = await gateway(model)
  await pack('desk', 'Desk', 'Greets guests at the desk and echoes their notes.')
  await pack('desk-all', 'Desk all', 'Greets guests at the desk and echoes their notes.')
  await pack('desk-gone', 'Desk gone', 'Greets guests at the desk and echoes their notes.')
  const done = await build('desk', TASKS)

  it('proposes tools with reasons, wording, variables, input modes, playbooks and a skill', () => {
    expect(done).toMatchObject({ status: 'ready', mode: 'build', stopped: null, error: null, notDone: [] })
    expect(done.proposal.lines.map((line: { id: string }) => line.id)).toEqual([
      'tool:fixture.greet',
      'tool:fixture.echo',
      'wording:fixture.greet',
      'input:fixture.greet.from',
      'variable:desk_name',
      'playbook:greet-guest',
      'playbook:echo-note',
      'skill',
    ])
    const lines = new Map(done.proposal.lines.map((line: { id: string }) => [line.id, line]))
    expect(lines.get('tool:fixture.greet')).toMatchObject({ reason: 'Greets the guest.', suggested: true })
    expect(lines.get('input:fixture.greet.from')).toMatchObject({
      after: { mode: 'fixed', value: '{{desk_name}}' },
      needs: ['tool:fixture.greet', 'variable:desk_name'],
    })
    // A tool it wasn't offered never comes in: it is said to be left out
    expect(done.proposal.skipped).toEqual([
      { name: 'fixture.shout', reason: 'Nothing here needs shouting.' },
      { name: 'fixture.whisper', reason: 'Not one of the tools this build looked at, so not added.' },
      { name: 'elsewhere.send_mail', reason: 'Not one of the tools this build looked at, so not added.' },
    ])
    expect(done.proposal.model).toBe('fake/writer')
    expect(done.spent).toMatchObject({ known: true })
    expect(done.spent.modelCalls).toBe(model.asks.length)
    expect(model.asks.map((ask) => ask.step)).toEqual([
      'kit',
      'playbook',
      'playbook',
      'skill',
      'rehearse',
      'rehearse',
      'rehearse',
    ])
  })

  it('rehearses with the pack’s own values, filled in by the pack lock', async () => {
    const [first] = done.proposal.rehearsal
    expect(first).toMatchObject({
      task: TASKS[0],
      outcome: 'Greeted Ada from the front desk.',
      steps: [{ tool: 'fixture.greet', ran: true, standIn: null }],
    })
    const payload = await api(`/api/calls/${first.steps[0].callId}/payload`)
    expect(JSON.stringify(payload.json.result)).toContain('Hello Ada, from the front desk')
    // The model was shown the tool as the pack's keys see it: the fixed input hidden
    const ask = model.asks.find((entry) => entry.step === 'rehearse')
    expect(
      JSON.parse(ask?.user ?? '{}').tools.find((tool: { name: string }) => tool.name === 'fixture.greet').inputSchema
        .properties,
    ).not.toHaveProperty('from')
  })

  it('changes nothing in the pack until lines are accepted', async () => {
    const { json } = await api('/api/packs/desk')
    expect([json.tools, json.variables, json.ownPlaybooks, json.skill]).toEqual([[], [], [], null])
    expect(json.build).toEqual({ id: done.id, status: 'ready' })
  })

  it('refuses an input line without the variable its value writes, naming both', async () => {
    const refused = await api(`/api/packs/desk/builds/${done.id}/accept`, {
      method: 'POST',
      body: { lines: ['tool:fixture.greet', 'input:fixture.greet.from'] },
    })
    expect([refused.status, refused.json.detail]).toEqual([
      400,
      'Accepting input:fixture.greet.from needs variable:desk_name: tick both.',
    ])
  })

  it('applies exactly the lines accepted, once', async () => {
    const accepted = await api(`/api/packs/desk/builds/${done.id}/accept`, {
      method: 'POST',
      body: { lines: ['tool:fixture.echo', 'wording:fixture.greet', 'tool:fixture.greet'] },
    })
    expect([accepted.status, accepted.json.detail]).toEqual([200, undefined])
    expect(
      accepted.json.tools.map((tool: { name: string; wording: string | null; fixed: object }) => [
        tool.name,
        tool.wording,
        tool.fixed,
      ]),
    ).toEqual([
      ['fixture.greet', 'Greets a guest from the desk.', {}],
      ['fixture.echo', null, {}],
    ])
    expect([accepted.json.variables, accepted.json.ownPlaybooks, accepted.json.skill]).toEqual([[], [], null])
    expect(accepted.json.build).toBeNull()
    expect((await api(`/api/packs/desk/builds/${done.id}`)).json.status).toBe('accepted')
    const again = await api(`/api/packs/desk/builds/${done.id}/accept`, {
      method: 'POST',
      body: { lines: ['variable:desk_name'] },
    })
    expect([again.status, again.json.detail]).toEqual([
      409,
      'This proposal was already accepted: build again for a new one.',
    ])
  })

  it('accepted whole, gives a pack whose checks pass, its texts written by ai', async () => {
    const all = await build('desk-all', TASKS)
    const lines = all.proposal.lines.filter((line: { suggested: boolean }) => line.suggested)
    expect(lines).toHaveLength(all.proposal.lines.length)
    const accepted = await api(`/api/packs/desk-all/builds/${all.id}/accept`, {
      method: 'POST',
      body: { lines: lines.map((line: { id: string }) => line.id) },
    })
    expect([accepted.status, accepted.json.detail]).toEqual([200, undefined])
    expect(accepted.json.findings.filter((finding: { level: string }) => finding.level === 'error')).toEqual([])
    expect(accepted.json.ownPlaybooks.map((playbook: { name: string }) => playbook.name)).toEqual([
      'greet-guest',
      'echo-note',
    ])
    expect(accepted.json.skill.sections).toHaveLength(6)
    const versions = await api('/api/packs/desk-all/playbooks/greet-guest')
    expect(versions.json.versions.map((version: { source: string }) => version.source)).toEqual(['ai'])
  })

  it('discarded, leaves the pack as it was', async () => {
    const gone = await build('desk-gone', TASKS)
    expect((await api(`/api/packs/desk-gone/builds/${gone.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await api(`/api/packs/desk-gone/builds/${gone.id}`)).json.status).toBe('discarded')
    const { json } = await api('/api/packs/desk-gone')
    expect([json.tools, json.variables, json.build]).toEqual([[], [], null])
    expect(
      (await api(`/api/packs/desk-gone/builds/${gone.id}/accept`, { method: 'POST', body: { lines: [] } })).status,
    ).toBe(409)
  })

  it('is read only by its own pack', async () => {
    expect((await api(`/api/packs/desk-all/builds/${done.id}`)).status).toBe(404)
  })

  it('refuses a line on a tool that is no longer live, as adding it by hand is', async () => {
    upstream.state.whisper = true
    await api('/api/upstreams/fixture/sync', { method: 'POST' })
    await pack('desk-quiet', 'Desk quiet', 'Greets guests at the desk and whispers to them.')
    const quiet = await build('desk-quiet', ['whisper hello to a guest'])
    expect(quiet.proposal.lines.map((line: { id: string }) => line.id)).toContain('tool:fixture.whisper')
    upstream.state.whisper = false
    await api('/api/upstreams/fixture/sync', { method: 'POST' })
    const refused = await api(`/api/packs/desk-quiet/builds/${quiet.id}/accept`, {
      method: 'POST',
      body: { lines: ['tool:fixture.whisper', 'tool:fixture.greet'] },
    })
    expect([refused.status, refused.json.detail]).toEqual([
      400,
      'Not live, so not added: fixture.whisper. Untick its lines, or sync its connection and build again.',
    ])
    expect((await api('/api/packs/desk-quiet')).json.tools).toEqual([])
  })

  it('says when a tool it tried was refused, without its result', async () => {
    const tried = await build('desk-quiet', ['greet a guest called Ada, from the boss'])
    const [step] = tried.proposal.rehearsal[0].steps
    expect(step).toEqual({
      tool: 'fixture.greet',
      ran: true,
      callId: null,
      standIn: null,
      error: 'fixture.greet: Desk quiet fills from itself, so leave it out.',
    })
  })

  it('refuses accept when the pack changed since the proposal', async () => {
    await pack('desk-moved', 'Desk moved', 'Greets guests at the desk and echoes their notes.')
    const moved = await build('desk-moved', TASKS)
    await api('/api/packs/desk-moved', { method: 'PATCH', body: { title: 'Desk, moved' } })
    const refused = await api(`/api/packs/desk-moved/builds/${moved.id}/accept`, {
      method: 'POST',
      body: { lines: ['tool:fixture.echo'] },
    })
    expect([refused.status, refused.json.detail]).toEqual([
      409,
      'Desk, moved changed since this proposal was made: discard it and build again.',
    ])
  })
})

describe('a rehearsal', async () => {
  const LOUD = {
    kit: {
      tools: [
        { name: 'fixture.echo', reason: 'Says it back.' },
        { name: 'fixture.shout', reason: 'Says it loudly.' },
      ],
    },
    playbook: {
      name: 'say-it-loud',
      markdown: '---\ntitle: Say it loud\ndescription: Says it.\n---\n\n1. Run `fixture.echo`, then `fixture.shout`.\n',
    },
    rehearse: (ask: Ask) =>
      [
        { tool: 'fixture.echo', arguments: { text: 'zebra-crossing-7' } },
        { tool: 'fixture.shout', arguments: { text: 'zebra-crossing-7' } },
        { done: true, outcome: 'Said it, then shouted it.' },
      ][Math.min(said(ask).steps.length, 2)],
  }
  const model = fakeModel(LOUD)
  const { api, pack, build, app } = await gateway(model)
  await pack('loud', 'Loud', 'Says things back, loudly: echo and shout.')
  let done: any

  it('runs a tool that only reads and never one that changes things', async () => {
    const before = upstream.state.calls
    done = await build('loud', ['shout a word back'])
    expect(upstream.state.calls - before).toBe(1)
    const [rehearsal] = done.proposal.rehearsal
    expect(rehearsal.steps).toEqual([
      { tool: 'fixture.echo', ran: true, callId: expect.stringMatching(/^call_/), standIn: null, error: null },
      {
        tool: 'fixture.shout',
        ran: false,
        callId: null,
        standIn: '[Not run in rehearsal: fixture.shout changes things. Assume it worked.]',
        error: null,
      },
    ])
    // What the tool returned went to the model only
    expect(JSON.stringify(done)).not.toContain('zebra-crossing-7')
    const logged = await api('/api/calls?via=rehearsal')
    expect(logged.json._embedded.calls.map((call: { tool: string; via: string }) => [call.tool, call.via])).toEqual([
      ['fixture.echo', 'rehearsal'],
    ])
    expect(done.proposal.lines.find((line: { id: string }) => line.id === 'tool:fixture.shout')).toMatchObject({
      changesThings: true,
      suggested: false,
    })
  })

  it('leaves its calls out of Home, a tool’s use and the setup, and shows them when asked', async () => {
    const home = (await api('/api/overview')).json
    expect(home.calls.last24h.total).toBe(0)
    expect(home.calls.last7d.total).toBe(0)
    expect(home.upstreams.find((row: { id: string }) => row.id === 'fixture').calls24h).toBe(0)
    expect(home.topTools).toEqual([])
    expect(home.setup.steps.find((step: { id: string }) => step.id === 'try').done).toBe(false)
    const listed = (await api('/api/tools?upstream=fixture')).json._embedded.tools
    expect(listed.find((tool: { name: string }) => tool.name === 'fixture.echo').calls7d).toBe(0)
    expect((await api('/api/overview/stats?range=24h')).json.tiles.now.calls).toBe(0)
    expect((await api('/api/overview/stats?range=24h&via=rehearsal')).json.tiles.now.calls).toBe(1)
  })

  it('is a door no caller can claim', async () => {
    const claimed = await api('/api/calls', {
      method: 'POST',
      headers: { 'x-gateway-via': 'rehearsal' },
      body: { tool: 'fixture.echo', arguments: { text: 'a' } },
    })
    expect((await api(`/api/calls/${claimed.json.id}`)).json.via).toBe('rest')
  })

  it('never runs a tool the owner set to read whose hints say it changes things', async () => {
    await api('/api/tools/fixture.shout', { method: 'PATCH', body: { access: 'read' } })
    await pack('loud-read', 'Loud read', 'Says things back, loudly: echo and shout.')
    const calls = upstream.state.calls
    const read = await build('loud-read', ['shout a word back'])
    expect(read.proposal.rehearsal[0].steps.map((step: { ran: boolean }) => step.ran)).toEqual([true, false])
    expect(upstream.state.calls - calls).toBe(1)
    await api('/api/tools/fixture.shout', { method: 'PATCH', body: { access: null } })
  })

  it('never runs a tool whose published route is not a read', async () => {
    upstream.state.echoRoute = 'POST /api/v1/echo'
    await api('/api/upstreams/fixture/sync', { method: 'POST' })
    expect((await app.services.tools.live('fixture.echo'))?.route).toBe('POST /api/v1/echo')
    await pack('loud-post', 'Loud post', 'Says things back, loudly: echo and shout.')
    const calls = upstream.state.calls
    const posted = await build('loud-post', ['shout a word back'])
    expect(posted.proposal.rehearsal[0].steps.map((step: { ran: boolean }) => step.ran)).toEqual([false, false])
    expect(upstream.state.calls).toBe(calls)
    upstream.state.echoRoute = 'GET /api/v1/echo'
    await api('/api/upstreams/fixture/sync', { method: 'POST' })
  })

  it('never runs a tool the owner switched off', async () => {
    await pack('loud-off', 'Loud off', 'Says things back, loudly: echo and shout.', ['fixture.echo'])
    await api('/api/tools/fixture.echo', { method: 'PATCH', body: { access: 'off' } })
    const calls = upstream.state.calls
    const off = await build('loud-off', ['shout a word back'], 'refresh')
    expect(off.proposal.rehearsal[0].steps[0]).toEqual({
      tool: 'fixture.echo',
      ran: false,
      callId: null,
      standIn: '[Not run in rehearsal: fixture.echo is switched off by the owner.]',
      error: null,
    })
    expect(upstream.state.calls).toBe(calls)
    await api('/api/tools/fixture.echo', { method: 'PATCH', body: { access: null } })
  })
})

describe('the spend cap', () => {
  it('stops a build that runs dearer than estimated, keeping what it has', async () => {
    const model = deskModel({ costUsd: 0.4 })
    const { pack, build } = await gateway(model)
    await pack('desk', 'Desk', 'Greets guests at the desk and echoes their notes.')
    const stopped = await build('desk', ['greet a guest called Ada'])
    expect(model.asks.map((ask) => ask.step)).toEqual(['kit', 'playbook'])
    expect(stopped).toMatchObject({
      status: 'stopped',
      stopped: 'cap',
      spent: { usd: 0.8, modelCalls: 2, known: true },
      notDone: ['the skill', 'the rehearsal of “greet a guest called Ada”'],
    })
    expect(stopped.proposal.lines.map((line: { id: string }) => line.id)).toContain('playbook:greet-guest')
  })

  it('stops the same way when the provider refuses for money', async () => {
    const model = deskModel({ refuse: 2 })
    const { pack, build } = await gateway(model)
    await pack('desk', 'Desk', 'Greets guests at the desk and echoes their notes.')
    const stopped = await build('desk', ['greet a guest called Ada'])
    expect(model.asks).toHaveLength(2)
    expect(stopped).toMatchObject({
      status: 'stopped',
      stopped: 'provider',
      notDone: [
        'the playbook for “greet a guest called Ada”',
        'the skill',
        'the rehearsal of “greet a guest called Ada”',
      ],
    })
  })

  it('refuses a build estimated over the cap before asking anything', async () => {
    const model = deskModel({ price: { input: 500, output: 500 } })
    const { api, pack } = await gateway(model)
    await pack('desk', 'Desk', 'Greets guests at the desk and echoes their notes.')
    const estimate = await api('/api/packs/desk/builds/estimate', {
      method: 'POST',
      body: { mode: 'build', tasks: TASKS },
    })
    expect(estimate.json.usd).toBeGreaterThan(1)
    const refused = await api('/api/packs/desk/builds', { method: 'POST', body: { mode: 'build', tasks: TASKS } })
    expect([refused.status, refused.json.code]).toEqual([429, 'spend_cap'])
    expect(refused.json.detail).toMatch(
      /^This build is estimated at \$\d+\.\d\d, over the \$1\.00 a build may spend: give fewer example tasks\.$/,
    )
    expect(model.asks).toEqual([])
  })
})

describe('the estimate and the doors', async () => {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const model = deskModel({
    price: null,
    rehearse: async () => {
      await held
      return { done: true, outcome: 'Done.' }
    },
  })
  const { api, pack, app, db, settled } = await gateway(model)
  await pack('desk', 'Desk', 'Greets guests at the desk and echoes their notes.')

  it('asks nothing, and says when the cost is not known', async () => {
    const estimate = await api('/api/packs/desk/builds/estimate', {
      method: 'POST',
      body: { mode: 'build', tasks: TASKS },
    })
    expect(estimate.status).toBe(200)
    expect(estimate.json).toMatchObject({
      usd: null,
      capUsd: 1,
      priceKnown: false,
      model: 'fake/writer',
      realCalls: 12,
      modelCalls: { likely: 1 + 2 + 1 + 1 + 6, max: 1 + 2 + 1 + 1 + 12 },
      note: 'Cost not known for this provider: the build is held to 400,000 tokens instead.',
    })
    expect(model.asks).toEqual([])
  })

  it('is the owner’s alone, and only outside a pack’s address', async () => {
    const key = await api('/api/clients', { method: 'POST', body: { name: 'Sam', scope: 'write', upstreams: 'all' } })
    const body = { mode: 'build', tasks: TASKS }
    expect((await api('/api/packs/desk/builds/estimate', { method: 'POST', body }, key.json.key)).status).toBe(403)
    expect((await api('/p/desk/api/packs/desk/builds/estimate', { method: 'POST', body })).status).toBe(403)
    expect(
      (await api('/api/packs/desk/builds', { method: 'POST', body, headers: { 'x-gateway-pack': 'desk' } })).status,
    ).toBe(403)
  })

  it('runs one build at a time for a pack', async () => {
    const first = await api('/api/packs/desk/builds', {
      method: 'POST',
      body: { mode: 'build', tasks: ['greet a guest called Ada'] },
    })
    expect(first.status).toBe(202)
    const second = await api('/api/packs/desk/builds', {
      method: 'POST',
      body: { mode: 'build', tasks: ['greet a guest called Ada'] },
    })
    expect([second.status, second.json.detail]).toEqual([
      409,
      `A build is already running for Desk: wait for it (GET /api/packs/desk/builds/${first.json.id}), then build again.`,
    ])
    const running = await api(`/api/packs/desk/builds/${first.json.id}`)
    expect(running.json).toMatchObject({ status: 'running', step: expect.stringMatching(/^Rehearsing/) })
    release()
    expect((await settled('desk', first.json.id)).status).toBe('ready')
  })

  it('reads a build a restart left running as failed, and builds again at once', async () => {
    const id = await app.services.builds.create({
      packId: String((await app.services.packs.get('desk'))?.id),
      mode: 'build',
      tasks: ['greet a guest called Ada'],
      estimate: { usd: null, tokens: 0, modelCalls: { likely: 0, max: 0 } },
      packUpdatedAt: new Date().toISOString(),
    })
    expect((await api(`/api/packs/desk/builds/${id}`)).json).toMatchObject({
      status: 'failed',
      error: 'Interrupted: the gateway restarted while it ran. Build again.',
    })
    expect(
      (
        await api('/api/packs/desk/builds', {
          method: 'POST',
          body: { mode: 'build', tasks: ['greet a guest called Ada'] },
        })
      ).status,
    ).toBe(202)
  })

  it('allows six builds an hour for one pack and caller', async () => {
    await pack('busy', 'Busy', 'Greets guests at the desk and echoes their notes.')
    const statuses = []
    for (let count = 0; count < 7; count++)
      statuses.push(
        (await api('/api/packs/busy/builds', { method: 'POST', body: { mode: 'build', tasks: ['x'.repeat(301)] } }))
          .status,
      )
    expect(statuses).toEqual([400, 400, 400, 400, 400, 400, 429])
    // Another pack has its own six
    expect(
      (await api('/api/packs/desk/builds/estimate', { method: 'POST', body: { mode: 'build', tasks: TASKS } })).status,
    ).toBe(200)
  })

  it('refuses a name no pack has as the route does, keeping nothing of the name', async () => {
    const guards = async () =>
      Number((await db.get<{ count: number }>(sql`select count(*) as count from kit_guards`))?.count)
    const kept = await guards()
    // A name the route can't take is a 400, one it can but no pack has a 404: never a 500 from the limit's header
    for (const [name, status] of [
      ['a%0d%0ab', 400],
      ['%E2%82%AC', 400],
      ['x'.repeat(3000), 400],
      ['nowhere', 404],
    ] as const) {
      const refused = await api(`/api/packs/${name}/builds`, { method: 'POST', body: { mode: 'build', tasks: TASKS } })
      expect([name.slice(0, 12), refused.status]).toEqual([name.slice(0, 12), status])
    }
    expect(await guards()).toBe(kept)
  })
})

describe('a model that answers the wrong shape', () => {
  it('fails the build with what was wrong, and the pack can be built again at once', async () => {
    const model = fakeModel({ shape: 'wrong' })
    const { api, pack, build } = await gateway(model)
    await pack('desk', 'Desk', 'Greets guests at the desk and echoes their notes.')
    const failed = await build('desk', ['greet a guest called Ada'])
    expect(failed).toMatchObject({ status: 'failed', proposal: null })
    expect(failed.error).toMatch(/^The model's answer for the kit didn't fit: tools: /)
    expect((await api('/api/packs/desk')).json.build).toBeNull()
    expect(
      (await api('/api/packs/desk/builds', { method: 'POST', body: { mode: 'build', tasks: ['say a thing'] } })).status,
    ).toBe(202)
  })
})

describe('a variable a model drafts', () => {
  it('is accepted as the variables route takes it, so the owner can save the pack’s variables back', async () => {
    const { api, pack, build } = await gateway(
      fakeModel({
        kit: { tools: [], variables: [{ name: 'desk_name', value: 'the desk', description: 'w'.repeat(600) }] },
      }),
    )
    await pack('desk', 'Desk', 'Greets guests at the desk and echoes their notes.')
    const done = await build('desk', ['greet a guest called Ada'])
    const accepted = await api(`/api/packs/desk/builds/${done.id}/accept`, {
      method: 'POST',
      body: { lines: ['variable:desk_name'] },
    })
    expect([accepted.status, accepted.json.detail]).toEqual([200, undefined])
    const variables = accepted.json.variables.map(({ name, value, description }: Record<string, unknown>) => ({
      name,
      value,
      description,
    }))
    const saved = await api('/api/packs/desk/variables', { method: 'PUT', body: { variables } })
    expect([saved.status, saved.json.detail]).toEqual([200, undefined])
  })
})

describe('what a build keeps', () => {
  it('keeps its proposal sealed, and drops builds older than 30 days', async () => {
    const { db, pack, build, app } = await gateway(deskModel())
    await pack('desk', 'Desk', 'Greets guests at the desk and echoes their notes.')
    const done = await build('desk', TASKS)
    const stored = JSON.stringify(await db.all(sql`select proposal from pack_builds where id = ${done.id}`))
    expect(stored).toContain('.')
    expect(stored).not.toContain('greet-guest')
    expect(stored).not.toContain('desk_name')
    await app.services.builds.prune(new Date(Date.now() + 31 * 24 * 3_600_000).toISOString())
    expect(await db.all(sql`select id from pack_builds`)).toEqual([])
  })
})
