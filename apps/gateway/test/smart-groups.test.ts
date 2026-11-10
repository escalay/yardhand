/**
 * Smart grouping against a stand-in model server: the writer names a connection's groups, the decider files each
 * tool; new tools are filed by the decider; a regroup is a preview first, and applying it keeps what the owner moved
 * and what is switched off.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { tidy } from '../src/features/groups/smart.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { LLM_KEY, startLlm } from './fixtures/llm.js'

const OWNER = 'owner-key-for-smart-groups'
const llm = await startLlm()
afterAll(() => llm.close())
llm.state.groups = [
  {
    key: 'datasets',
    title: 'Datasets',
    purpose: 'Test data for evaluations.',
    tools: ['list_datasets', 'create_dataset', 'delete_dataset', 'get_dataset_run'],
  },
  {
    key: 'dashboards',
    title: 'Dashboards',
    purpose: 'Charts of traces.',
    tools: ['list_dashboards', 'get_dashboard', 'delete_dashboard'],
  },
]
const app = await createApp({
  db: await testDb(),
  env: {
    API_KEYS: `owner:${hashApiKey(OWNER)}`,
    GATEWAY_MASTER_KEY: randomBytes(32).toString('base64'),
    GATEWAY_AI_GROUPING_PROVIDER: 'custom',
    GATEWAY_AI_GROUPING_BASE_URL: llm.baseUrl,
    GATEWAY_AI_GROUPING_KEY: LLM_KEY,
    GATEWAY_AI_GROUPING_WRITER_MODEL: 'writer-1',
    GATEWAY_AI_GROUPING_DECIDER_MODEL: 'decider-1',
  },
})
type Init = { method?: string; body?: unknown }
const owner = async (path: string, init: Init = {}) => {
  const response = await app.request(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  return { status: response.status, json: (await response.json().catch(() => null)) as any }
}
const endpoint = (name: string, method: string) => ({ name, method, path: `/${name}`, description: `${name}.` })
const ENDPOINTS = [
  endpoint('listDatasets', 'get'),
  endpoint('createDataset', 'post'),
  endpoint('deleteDataset', 'delete'),
  endpoint('listDashboards', 'get'),
  endpoint('getDashboard', 'get'),
  endpoint('deleteDashboard', 'delete'),
  endpoint('getHealth', 'get'),
]
const titlesOf = (view: any) => view.groups.map((group: { title: string; tools: number }) => [group.title, group.tools])

describe('smart grouping', () => {
  it('groups a new connection with the models: named groups with a purpose, every tool filed', async () => {
    const made = await owner('/api/upstreams', {
      method: 'POST',
      body: {
        id: 'stats',
        kind: 'http',
        url: 'http://127.0.0.1:9/api',
        http: { endpoints: ENDPOINTS },
        auth: { type: 'none' },
        trust: 'trusted',
      },
    })
    expect(made.status).toBe(201)
    const view = (await owner('/api/upstreams/stats/groups')).json
    expect(view).toMatchObject({ groupedBy: 'ai', smart: true })
    expect(titlesOf(view)).toEqual([
      ['Datasets', 3],
      ['Dashboards', 3],
      ['Other', 1],
    ])
    expect(view.groups[0].purpose).toBe('Test data for evaluations.')
    expect(llm.asks.map((ask) => ask.model)).toEqual(['writer-1', 'decider-1'])
  })

  it('files a tool the server adds later with the decider', async () => {
    await owner('/api/upstreams/stats', {
      method: 'PATCH',
      body: { http: { endpoints: [...ENDPOINTS, endpoint('getDatasetRun', 'get')] } },
    })
    expect((await owner('/api/tools/stats.get_dataset_run')).json.group).toEqual({ key: 'datasets', title: 'Datasets' })
    expect(llm.asks.at(-1)?.model).toBe('decider-1')
  })

  it('previews a regroup, then applies it, keeping what the owner moved and what is off', async () => {
    await owner('/api/upstreams/stats/groups/dashboards', { method: 'PATCH', body: { off: true } })
    await owner('/api/tools/stats.get_health/group', { method: 'PUT', body: { group: 'datasets' } })
    llm.state.groups = [
      {
        key: 'evaluation-data',
        title: 'Evaluation data',
        purpose: 'Datasets and their runs.',
        tools: ['list_datasets', 'create_dataset', 'delete_dataset', 'get_dataset_run'],
      },
      {
        key: 'charts',
        title: 'Charts',
        purpose: 'Dashboards.',
        tools: ['list_dashboards', 'get_dashboard', 'delete_dashboard'],
      },
    ]
    const proposal = (await owner('/api/upstreams/stats/regroup', { method: 'POST' })).json
    expect(proposal.after.map((group: { title: string }) => group.title)).toEqual([
      'Evaluation data',
      'Charts',
      'Other',
    ])
    expect(proposal.kept.sort()).toEqual([
      'stats.delete_dashboard',
      'stats.get_dashboard',
      'stats.get_health',
      'stats.list_dashboards',
    ])
    // Nothing changed yet
    expect((await owner('/api/tools/stats.list_datasets')).json.group.key).toBe('datasets')

    const applied = await owner('/api/upstreams/stats/groups', {
      method: 'PUT',
      body: { groups: proposal.after.map(({ off: _, ...group }: { off: boolean }) => group) },
    })
    expect(applied.status).toBe(200)
    expect((await owner('/api/tools/stats.list_datasets')).json.group.key).toBe('evaluation-data')
    // Moved by the owner, and in an off group: where they were, and still off
    expect((await owner('/api/tools/stats.get_health')).json.group.key).toBe('datasets')
    expect((await owner('/api/tools/stats.list_dashboards')).json).toMatchObject({
      group: { key: 'dashboards' },
      offBy: 'group',
    })
  })

  it('keeps a group the owner named through a regroup that proposes it again', async () => {
    await owner('/api/upstreams/stats/groups/evaluation-data', { method: 'PATCH', body: { title: 'My data' } })
    const proposal = (await owner('/api/upstreams/stats/regroup', { method: 'POST' })).json
    expect(proposal.after[0]).toMatchObject({ key: 'evaluation-data', title: 'My data' })
    const applied = await owner('/api/upstreams/stats/groups', {
      method: 'PUT',
      body: { groups: proposal.after.map(({ off: _, ...group }: { off: boolean }) => ({ ...group, title: 'Theirs' })) },
    })
    expect(applied.json.groups.find((group: { key: string }) => group.key === 'evaluation-data')).toMatchObject({
      title: 'My data',
      source: 'owner',
    })
  })

  it('leaves a group the owner named whole when a regroup proposes other groups', async () => {
    llm.state.groups = [
      {
        key: 'everything',
        title: 'Everything',
        purpose: 'All of it.',
        tools: ['list_datasets', 'create_dataset', 'delete_dataset', 'get_dataset_run'],
      },
    ]
    const proposal = (await owner('/api/upstreams/stats/regroup', { method: 'POST' })).json
    expect(proposal.kept).toContain('stats.list_datasets')
    await owner('/api/upstreams/stats/groups', {
      method: 'PUT',
      body: { groups: proposal.after.map(({ off: _, ...group }: { off: boolean }) => group) },
    })
    expect((await owner('/api/tools/stats.list_datasets')).json.group).toMatchObject({
      key: 'evaluation-data',
      title: 'My data',
    })
  })

  it('gives leftovers one more round: broader groups for small kinds, and the first round if that fails', async () => {
    const pair = (noun: string) => [endpoint(`get${noun}`, 'get'), endpoint(`list${noun}s`, 'get')]
    await owner('/api/upstreams', {
      method: 'POST',
      body: {
        id: 'shop',
        kind: 'http',
        url: 'http://127.0.0.1:9/api',
        http: {
          endpoints: [
            endpoint('getCustomer', 'get'),
            endpoint('searchCustomers', 'get'),
            endpoint('filterCustomers', 'get'),
            ...pair('Invoice'),
            ...pair('Payment'),
            ...pair('Refund'),
          ],
        },
        auth: { type: 'none' },
        trust: 'trusted',
      },
    })
    const kind = (key: string, title: string, tools: string[]) => ({ key, title, purpose: `${title}.`, tools })
    llm.state.groups = [
      kind('customers', 'Customers', ['get_customer', 'search_customers', 'filter_customers']),
      kind('invoices', 'Invoices', ['get_invoice', 'list_invoices']),
      kind('payments', 'Payments', ['get_payment', 'list_payments']),
      kind('refunds', 'Refunds', ['get_refund', 'list_refunds']),
    ]
    llm.state.more = [kind('billing', 'Billing', ['get_invoice', 'list_invoices', 'get_payment', 'list_payments'])]
    const proposed = async () =>
      (await owner('/api/upstreams/shop/regroup', { method: 'POST' })).json.after.map(
        (group: { title: string; tools: string[] }) => [group.title, group.tools.length],
      )
    expect(await proposed()).toEqual([
      ['Customers', 3],
      ['Billing', 4],
      ['Other', 2],
    ])
    llm.state.failMore = true
    expect(await proposed()).toEqual([
      ['Customers', 3],
      ['Other', 6],
    ])
    llm.state.failMore = false
    llm.state.more = []
  })

  it('folds groups under three tools into Other, which keeps whatever it gets', () => {
    const groups = [
      { key: 'menus', title: 'Menus' },
      { key: 'invoices', title: 'Invoices' },
      { key: 'other', title: 'Other' },
    ]
    const placed = new Map([
      ['b1', 'menus'],
      ['b2', 'menus'],
      ['b3', 'menus'],
      ['t1', 'invoices'],
      ['t2', 'invoices'],
      ['o1', 'other'],
    ])
    expect(tidy(groups, placed).map((group) => [group.title, group.tools])).toEqual([
      ['Menus', ['b1', 'b2', 'b3']],
      ['Other', ['t1', 't2', 'o1']],
    ])
  })

  it('says why it can’t regroup', async () => {
    const plain = await createApp({
      db: await testDb(),
      env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
    })
    await plain.request('/api/upstreams', {
      method: 'POST',
      headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'stats',
        kind: 'http',
        url: 'http://127.0.0.1:9/api',
        http: { endpoints: ENDPOINTS },
        auth: { type: 'none' },
        trust: 'trusted',
      }),
    })
    const refused = await plain.request('/api/upstreams/stats/regroup', {
      method: 'POST',
      headers: { authorization: `Bearer ${OWNER}` },
    })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { detail: string }).detail).toContain('Settings › AI')
  })
})
