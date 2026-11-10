/**
 * Tool groups: a connection's tools grouped by rules (here analytics-style names on a REST connection), switched off
 * by group or by effect, with the switch holding for tools added later, and the owner's own setting winning.
 */
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { TOOLS_MIGRATIONS } from '../src/features/tools/schema.js'
import { hashApiKey, testDb } from '../src/kit/index.js'

const OWNER = 'owner-key-for-groups'
const db = await testDb()
const app = await createApp({
  db,
  env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
})
type Init = { method?: string; body?: unknown }
const call = async (key: string, path: string, init: Init = {}) => {
  const response = await app.request(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  return { status: response.status, json: (await response.json().catch(() => null)) as any }
}
const owner = (path: string, init?: Init) => call(OWNER, path, init)
const endpoint = (name: string, method: string) => ({ name, method, path: `/${name}`, description: `${name}.` })
const ENDPOINTS = [
  endpoint('listDatasets', 'get'),
  endpoint('createDataset', 'post'),
  endpoint('deleteDataset', 'delete'),
  endpoint('listDashboards', 'get'),
  endpoint('deleteDashboard', 'delete'),
  endpoint('getHealth', 'get'),
]

const made = await owner('/api/upstreams', {
  method: 'POST',
  body: {
    id: 'stats',
    title: 'Analytics-ish',
    kind: 'http',
    url: 'http://127.0.0.1:9/api',
    http: { endpoints: ENDPOINTS },
    auth: { type: 'none' },
    trust: 'trusted',
  },
})
const agentKey = (
  await owner('/api/clients', { method: 'POST', body: { name: 'agent', scope: 'write', upstreams: 'all' } })
).json.key as string
const groups = async () => (await owner('/api/upstreams/stats/groups')).json

describe('tool groups', () => {
  it('groups a connection’s tools by the noun in their names, singles in Other, and counts by effect', async () => {
    expect(made.status).toBe(201)
    const view = await groups()
    expect(view.groupedBy).toBe('rules')
    expect(view.groups.map((group: { title: string; tools: number }) => [group.title, group.tools])).toEqual([
      ['Dashboards', 2],
      ['Datasets', 3],
      ['Other', 1],
    ])
    expect(view.groups[1].effects).toEqual({ reads: 1, changes: 1, deletes: 1 })
    expect(view.effects).toEqual([
      { effect: 'reads', tools: 3, off: false },
      { effect: 'changes', tools: 1, off: false },
      { effect: 'deletes', tools: 2, off: false },
    ])
    expect((await owner('/api/tools/stats.list_datasets')).json.group).toEqual({ key: 'dataset', title: 'Datasets' })
  })

  it('switches a group off for agents, and the owner can turn one of its tools back on', async () => {
    const off = await owner('/api/upstreams/stats/groups/dataset', { method: 'PATCH', body: { off: true } })
    expect(off.json.groups[1]).toMatchObject({ key: 'dataset', off: true, offTools: 3 })
    expect((await owner('/api/tools/stats.create_dataset')).json).toMatchObject({ access: 'off', offBy: 'group' })
    const listed = (await call(agentKey, '/api/tools?upstream=stats&limit=50')).json._embedded.tools.map(
      (tool: { name: string }) => tool.name,
    )
    expect(listed.sort()).toEqual(['stats.delete_dashboard', 'stats.get_health', 'stats.list_dashboards'])
    const refused = await call(agentKey, '/api/calls', {
      method: 'POST',
      body: { tool: 'stats.list_datasets', arguments: {} },
    })
    expect(refused.status).toBe(403)
    expect(refused.json.detail).toBe('stats.list_datasets is in Datasets, which the owner switched off.')
    await owner('/api/tools/stats.list_datasets', { method: 'PATCH', body: { access: 'read' } })
    expect((await owner('/api/tools/stats.list_datasets')).json).toMatchObject({ access: 'read', offBy: null })
    expect((await call(agentKey, '/api/tools/stats.list_datasets')).status).toBe(200)
  })

  it('keeps a tool the server adds later off when it lands in an off group', async () => {
    await owner('/api/upstreams/stats', {
      method: 'PATCH',
      body: { http: { endpoints: [...ENDPOINTS, endpoint('getDatasetRun', 'get')] } },
    })
    expect((await owner('/api/tools/stats.get_dataset_run')).json).toMatchObject({
      group: { key: 'dataset' },
      access: 'off',
      offBy: 'group',
    })
  })

  it('switches every tool that deletes off at once', async () => {
    const view = (await owner('/api/upstreams/stats/effects/deletes', { method: 'PATCH', body: { off: true } })).json
    expect(view.effects.find((entry: { effect: string }) => entry.effect === 'deletes').off).toBe(true)
    expect((await owner('/api/tools/stats.delete_dashboard')).json).toMatchObject({ access: 'off', offBy: 'effect' })
    expect((await owner('/api/tools/stats.list_dashboards')).json.offBy).toBeNull()
    await owner('/api/upstreams/stats/effects/deletes', { method: 'PATCH', body: { off: false } })
    expect((await owner('/api/tools/stats.delete_dashboard')).json.offBy).toBeNull()
  })

  it('counts under each switch only the tools it holds: one the owner set is theirs', async () => {
    const before = (await owner('/api/upstreams/stats/groups')).json
    const countOf = (view: any, effect: string) => view.effects.find((entry: any) => entry.effect === effect).tools
    await owner('/api/tools/stats.create_dataset', { method: 'PATCH', body: { access: 'read' } })
    const after = (await owner('/api/upstreams/stats/groups')).json
    expect(after.yours).toBe(before.yours + 1)
    expect(countOf(after, 'changes')).toBe(countOf(before, 'changes') - 1)
    const datasets = (view: any) => view.groups.find((group: any) => group.key === 'dataset').effects
    expect(datasets(after).reads).toBe(datasets(before).reads + 1)
    await owner('/api/tools/stats.create_dataset', { method: 'PATCH', body: { access: null } })
  })

  it('keeps a create off where deletes were off, once it counts as a change', async () => {
    const tool = async () => (await owner('/api/tools/stats.delete_dashboard')).json
    await owner('/api/upstreams/stats/effects/deletes', { method: 'PATCH', body: { off: true } })
    expect((await tool()).offBy).toBe('effect')
    // As an MCP server that marks every write destructive stores it: the hint on a name that builds, no route
    const [stored] = await db.all<{ route: string | null }>(
      sql`select route from tools where name = 'stats.delete_dashboard'`,
    )
    const route = stored?.route ?? null
    await db.run(
      sql`update tools set remote_name = 'createDashboardCopy', route = null where name = 'stats.delete_dashboard'`,
    )
    expect((await tool()).offBy).toBeNull()
    await db.run(sql.raw(TOOLS_MIGRATIONS.at(-1) as string))
    expect(await tool()).toMatchObject({ access: 'off', offBy: 'you' })
    await db.run(
      sql`update tools set remote_name = 'deleteDashboard', route = ${route}, access = null where name = 'stats.delete_dashboard'`,
    )
    await owner('/api/upstreams/stats/effects/deletes', { method: 'PATCH', body: { off: false } })
  })

  it('renames a group, makes one of the owner’s own, and moves a tool into it for good', async () => {
    const renamed = await owner('/api/upstreams/stats/groups/dashboard', { method: 'PATCH', body: { title: 'Menus' } })
    expect(renamed.json.groups[0]).toMatchObject({ key: 'dashboard', title: 'Menus', source: 'owner' })
    const added = await owner('/api/upstreams/stats/groups', { method: 'POST', body: { title: 'Admin' } })
    expect(added.json.groups.map((group: { key: string }) => group.key)).toContain('admin')
    const moved = await owner('/api/tools/stats.get_health/group', { method: 'PUT', body: { group: 'admin' } })
    expect(moved.json.groups.find((group: { key: string }) => group.key === 'admin').tools).toBe(1)
    await owner('/api/upstreams/stats/sync', { method: 'POST' })
    expect((await owner('/api/tools/stats.get_health')).json.group.key).toBe('admin')
    expect((await owner('/api/tools/stats.get_health/group', { method: 'PUT', body: { group: 'nope' } })).status).toBe(
      400,
    )
    expect((await owner('/api/upstreams/stats/groups', { method: 'POST', body: { title: 'Admin' } })).status).toBe(409)
  })

  it('lists a connection’s groups to an agent as that agent sees them, and narrows tools by one', async () => {
    const key = (
      await owner('/api/clients', { method: 'POST', body: { name: 'reader', scope: 'read', upstreams: ['stats'] } })
    ).json.key as string
    const groupsFor = async (who: string) =>
      Object.fromEntries(
        (await call(who, '/api/upstreams/stats')).json.groups.map((group: { title: string; tools: number }) => [
          group.title,
          group.tools,
        ]),
      )
    const all = await groupsFor(OWNER)
    const reader = await groupsFor(key)
    // A read-only key is counted only the reads; the owner everything
    expect(reader.Datasets).toBe(1)
    expect(all.Datasets).toBeGreaterThan(reader.Datasets)
    // A group that is off isn't listed to an agent at all
    await owner('/api/upstreams/stats/groups/dashboard', { method: 'PATCH', body: { off: true } })
    expect(await groupsFor(key)).not.toHaveProperty('Menus')
    expect(await groupsFor(OWNER)).toHaveProperty('Menus')
    await owner('/api/upstreams/stats/groups/dashboard', { method: 'PATCH', body: { off: false } })
    const narrowed = (await call(key, '/api/tools?upstream=stats&group=Datasets')).json._embedded.tools
    expect(narrowed.map((tool: { name: string }) => tool.name)).toEqual(['stats.list_datasets'])
  })

  it('deletes a group into Other, but never one that is off with tools in it', async () => {
    const remove = (key: string) => owner(`/api/upstreams/stats/groups/${key}`, { method: 'DELETE' })
    await owner('/api/upstreams/stats/groups/admin', { method: 'PATCH', body: { off: true } })
    const refused = await remove('admin')
    expect(refused.status).toBe(409)
    expect(refused.json.detail).toContain('would switch them on')
    expect((await owner('/api/tools/stats.get_health')).json.offBy).toBe('group')
    await owner('/api/upstreams/stats/groups/admin', { method: 'PATCH', body: { off: false } })
    const gone = await remove('admin')
    expect(gone.json.groups.map((group: { key: string }) => group.key)).not.toContain('admin')
    expect((await owner('/api/tools/stats.get_health')).json.group.key).toBe('other')
    expect((await remove('other')).status).toBe(400)
    expect((await remove('nope')).status).toBe(404)
  })
})
