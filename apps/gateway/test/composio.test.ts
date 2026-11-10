/**
 * Composio as an upstream, against a stand-in: the real tools of the chosen toolkits with Composio's titles and hints,
 * the accounts by their labels, every call picking its account, a pack fixing the account, in both modes.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { COMPOSIO_KEYS, startComposio } from './fixtures/composio.js'

const OWNER = 'owner-key-for-composio'
const composio = await startComposio()
afterAll(() => composio.close())

const appWith = async (env: Record<string, string> = {}) =>
  createApp({
    db: await testDb(),
    env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64'), ...env },
  })
const app = await appWith({ COMPOSIO_API_KEY: COMPOSIO_KEYS.user })

type Init = { method?: string; body?: unknown }
const call = async (target: { request: typeof app.request }, key: string, path: string, init: Init = {}) => {
  const response = await target.request(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  return { status: response.status, json: (await response.json().catch(() => null)) as any }
}
const owner = (path: string, init?: Init) => call(app, OWNER, path, init)
const personal = (catalogUrl = composio.origin) => ({
  id: 'composio',
  kind: 'composio',
  url: composio.mcpUrl,
  composio: { mode: 'personal', toolkits: ['gmail', 'googlecalendar'], catalogUrl },
  auth: { type: 'header', value: COMPOSIO_KEYS.personal },
  trust: 'trusted',
})

beforeAll(async () => {
  const made = await owner('/api/upstreams', { method: 'POST', body: personal() })
  expect(made.status).toBe(201)
})

describe('a personal Composio upstream', () => {
  it('lists the chosen toolkits’ tools by readable name, with Composio’s titles and hints', async () => {
    const upstream = (await owner('/api/upstreams/composio')).json
    expect(upstream).toMatchObject({
      kind: 'composio',
      status: 'live',
      toolCount: 3,
      linkProxy: false,
      auth: 'header',
      composio: { mode: 'personal', toolkits: ['gmail', 'googlecalendar'] },
    })
    const names = (await owner('/api/tools?upstream=composio')).json._embedded.tools.map(
      (tool: { name: string }) => tool.name,
    )
    // The deprecated one stays out
    expect(names.sort()).toEqual([
      'composio.gmail_delete_message',
      'composio.gmail_fetch_emails',
      'composio.googlecalendar_events_list',
    ])
    const fetch = (await owner('/api/tools/composio.gmail_fetch_emails')).json
    expect(fetch).toMatchObject({ title: 'Fetch emails', needsWrite: false })
    expect(Object.keys(fetch.inputSchema.properties)).toEqual(['query', 'max_results', 'account'])
    const remove = (await owner('/api/tools/composio.gmail_delete_message')).json
    expect(remove).toMatchObject({ needsWrite: true, annotations: { destructiveHint: true } })
  })

  it('lists its accounts by their labels, for the chosen toolkits only', async () => {
    const { json } = await owner('/api/upstreams/composio/accounts')
    expect(json._embedded.accounts).toEqual([
      {
        id: 'gmail_work',
        label: 'Work Email - me@work.test',
        toolkit: 'gmail',
        status: 'ACTIVE',
        isDefault: true,
        email: 'me@work.test',
      },
      { id: 'gmail_home', label: 'Home Email', toolkit: 'gmail', status: 'ACTIVE', isDefault: false, email: null },
      {
        id: 'gcal_work',
        label: 'Work Calendar',
        toolkit: 'googlecalendar',
        status: 'ACTIVE',
        isDefault: true,
        email: null,
      },
    ])
  })

  it('runs a tool on the account the call names, through the hosted MCP', async () => {
    const ran = await owner('/api/calls', {
      method: 'POST',
      body: { tool: 'composio.gmail_fetch_emails', arguments: { query: 'invoices', account: 'gmail_home' } },
    })
    expect(ran.json.status).toBe('ok')
    expect(ran.json.result.structuredContent).toMatchObject({ slug: 'GMAIL_FETCH_EMAILS', account: 'gmail_home' })
    expect(composio.seen.at(-1)).toEqual({
      slug: 'GMAIL_FETCH_EMAILS',
      account: 'gmail_home',
      arguments: { query: 'invoices', max_results: 10 },
      via: 'mcp',
    })
    const failed = await owner('/api/calls', {
      method: 'POST',
      body: { tool: 'composio.gmail_delete_message', arguments: { message_id: 'missing' } },
    })
    expect(failed.json.status).toBe('tool_error')
    expect(failed.json.result.content[0].text).toBe('Message missing not found')
  })

  it('lets a pack fix the account: its key never sees or changes it', async () => {
    await owner('/api/packs', { method: 'POST', body: { name: 'work', title: 'Work', description: 'My job.' } })
    const added = await owner('/api/packs/work', {
      method: 'PATCH',
      body: {
        add: {
          tools: [
            { name: 'composio.gmail_fetch_emails', alias: 'work_inbox', fixed: { account: 'gmail_work' } },
            { name: 'composio.googlecalendar_events_list', alias: 'work_calendar', fixed: { account: 'gcal_work' } },
          ],
        },
      },
    })
    expect(added.status).toBe(200)
    const key = (await owner('/api/clients', { method: 'POST', body: { name: 'work-laptop', pack: 'work' } })).json.key
    const me = (await call(app, key, '/api/me')).json
    expect(me.pins.map((pin: { name: string }) => pin.name)).toEqual(['work_inbox', 'work_calendar'])
    expect(Object.keys(me.pins[0].inputSchema.properties)).toEqual(['query', 'max_results'])
    await call(app, key, '/api/calls', {
      method: 'POST',
      body: { tool: 'work_inbox', arguments: { query: 'standup' } },
    })
    expect(composio.seen.at(-1)).toMatchObject({ slug: 'GMAIL_FETCH_EMAILS', account: 'gmail_work' })
    const forged = await call(app, key, '/api/calls', {
      method: 'POST',
      body: { tool: 'work_inbox', arguments: { query: 'x', account: 'gmail_home' } },
    })
    expect(forged.status).toBe(400)
  })

  it('groups its tools by app, named as Composio names them; an app switched off isn’t fetched', async () => {
    const view = (await owner('/api/upstreams/composio/groups')).json
    expect(view.groupedBy).toBe('apps')
    expect(
      view.groups.map((group: { key: string; title: string; tools: number }) => [group.key, group.title, group.tools]),
    ).toEqual([
      ['gmail', 'Gmail', 2],
      ['googlecalendar', 'Google Calendar', 1],
    ])
    const off = (await owner('/api/upstreams/composio/groups/gmail', { method: 'PATCH', body: { off: true } })).json
    expect(off.groups[0]).toMatchObject({ key: 'gmail', off: true, tools: 0, app: { fetched: false, available: 3 } })
    expect((await owner('/api/upstreams/composio')).json).toMatchObject({
      toolCount: 1,
      composio: { toolkits: ['gmail', 'googlecalendar'], off: ['gmail'] },
    })
    const on = (await owner('/api/upstreams/composio/groups/gmail', { method: 'PATCH', body: { off: false } })).json
    expect(on.groups[0]).toMatchObject({ key: 'gmail', off: false, tools: 2 })
    expect(
      (await owner('/api/upstreams/composio/groups', { method: 'POST', body: { app: 'slack' } })).json.groups.map(
        (group: { key: string }) => group.key,
      ),
    ).toEqual(['gmail', 'googlecalendar', 'slack'])
  })

  it('says what is missing: toolkits to list, or the key that reads the tool list', async () => {
    const noToolkits = await owner('/api/upstreams', {
      method: 'POST',
      body: { ...personal(), id: 'composio-2', composio: undefined },
    })
    expect(noToolkits.status).toBe(400)
    const bare = await appWith()
    const made = await call(bare, OWNER, '/api/upstreams', { method: 'POST', body: personal() })
    expect(made.json).toMatchObject({ status: 'failing', sync: null })
    expect(made.json.lastError).toContain('COMPOSIO_API_KEY')
  })
})

describe('a project Composio upstream', () => {
  it('lists, finds accounts and runs through the REST API with the project key and user', async () => {
    const made = await owner('/api/upstreams', {
      method: 'POST',
      body: {
        id: 'composio-dev',
        kind: 'composio',
        url: composio.origin,
        composio: { mode: 'project', toolkits: ['gmail'], userId: 'user-1', catalogUrl: composio.origin },
        auth: { type: 'header', value: COMPOSIO_KEYS.project },
        trust: 'trusted',
      },
    })
    expect(made.status).toBe(201)
    expect(made.json.sync.added.sort()).toEqual([
      'composio-dev.gmail_delete_message',
      'composio-dev.gmail_fetch_emails',
    ])
    const accounts = (await owner('/api/upstreams/composio-dev/accounts')).json._embedded.accounts
    expect(accounts.map((account: { id: string; label: string }) => [account.id, account.label])).toEqual([
      ['ca_gmail_work', 'Work Email - me@work.test'],
      ['ca_gmail_home', 'Home Email'],
    ])
    await owner('/api/calls', {
      method: 'POST',
      body: { tool: 'composio-dev.gmail_fetch_emails', arguments: { account: 'ca_gmail_home' } },
    })
    expect(composio.seen.at(-1)).toEqual({
      slug: 'GMAIL_FETCH_EMAILS',
      account: 'ca_gmail_home',
      arguments: { max_results: 10 },
      via: 'rest',
    })
  })

  it('has no accounts on an upstream that isn’t Composio', async () => {
    expect((await owner('/api/upstreams/nope/accounts')).status).toBe(404)
  })
})
