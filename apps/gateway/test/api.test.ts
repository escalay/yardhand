import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, TOOLS } from '../src/app.js'
import { GUIDE_VARS } from '../src/guide.vars.js'
import { guideFiles, guideModuleSource, hashApiKey, testDb } from '../src/kit/index.js'
import { guideGaps, lintOpenApi, toolRoutes, toolsRun } from '../src/kit/testing/index.js'
import { startUpstream } from './fixtures/upstream.js'

const GUIDE_DIR = fileURLToPath(new URL('../guide', import.meta.url))
const KEY = 'test-key'
const headers = { authorization: `Bearer ${KEY}` }
const upstream = await startUpstream({ token: 'fixture-token' })
const app = await createApp({
  db: await testDb(),
  env: { API_KEYS: `owner:${hashApiKey(KEY)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
})
await app.request('/api/upstreams', {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    id: 'fixture',
    url: upstream.url,
    auth: { type: 'bearer', value: 'fixture-token' },
    trust: 'trusted',
  }),
})
const doc = async () => (await app.request('/openapi.json', { headers })).json()
afterAll(() => upstream.close())

describe('the API', () => {
  it('documents every route to the standard, and every tool lands on one', async () => {
    expect(lintOpenApi(await doc())).toEqual([])
    expect(toolRoutes(TOOLS, await doc())).toEqual([])
  })

  it('runs every MCP tool against its route', async () => {
    // A result over the cap (MCP only) is held, so get_result has a page 2 to read
    const big = await app.request('/api/calls', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'x-gateway-via': 'mcp' },
      body: JSON.stringify({ tool: 'fixture.echo', arguments: { text: 'x'.repeat(250_000) } }),
    })
    const { id } = (await big.json()) as { id: string }
    const samples = {
      search_tools: { query: 'echo' },
      describe_tool: { name: 'fixture.echo' },
      list_upstreams: {},
      get_result: { call_id: id, page: 2 },
      read_resource: { uri: 'gateway://u/fixture/manual' },
      get_playbook: { name: 'fixture-warm-up' },
    }
    expect(await toolsRun(TOOLS, app, samples, { headers })).toEqual([])
  })

  it('fills every placeholder in the agent guide', async () => {
    expect(guideGaps(guideFiles(GUIDE_DIR), GUIDE_VARS, { doc: await doc(), tools: TOOLS })).toEqual([])
  })

  it('serves a {{name}} the guide writes as a literal, through the guide’s own variable', async () => {
    const guide = await (await app.request('/llms.txt', { headers })).text()
    expect(guide).toContain("writes an argument or one of the pack's variables as `{{name}}`")
    expect(guide).toContain('with `query` set to {{role}}, in {{city}}.')
    // Nothing of the trick is left in what is served
    expect(guide).not.toContain('{{open}}')
    expect(guide).not.toMatch(/\{\{\{/)
  })

  it('names only routes that exist where it says how to write a pack', async () => {
    const guide = guideFiles(GUIDE_DIR).get('llms.txt') ?? ''
    const section = guide.slice(guide.indexOf('## Writing a pack'), guide.indexOf('## Rules worth knowing'))
    const { paths } = (await doc()) as { paths: Record<string, Record<string, unknown>> }
    const named = [...section.matchAll(/`(GET|POST|PUT|PATCH|DELETE) (\/api\/[^`\s?]+)/g)].map(
      ([, method = '', path = '']) => ({ method: method.toLowerCase(), path }),
    )
    expect(named.map(({ method, path }) => `${method} ${path}`)).toEqual(
      expect.arrayContaining([
        'put /api/packs/{name}/variables',
        'patch /api/packs/{name}/tools/{tool}',
        'post /api/packs/{name}/playbooks',
        'put /api/packs/{name}/skill',
        'post /api/packs/{name}/checks',
      ]),
    )
    expect(named.filter(({ method, path }) => !paths[path]?.[method])).toEqual([])
  })

  it('serves the guide folder as it is now (run `pnpm guide` after editing guide/)', () => {
    expect(readFileSync(new URL('../src/guide.gen.ts', import.meta.url), 'utf8')).toBe(
      guideModuleSource(guideFiles(GUIDE_DIR)),
    )
  })
})
