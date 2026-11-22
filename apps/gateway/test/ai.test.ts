/** Settings › AI: each setting from Settings, .env or a default; keys sealed and never shown; tests and models. */
import { randomBytes } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashApiKey, testDb } from '../src/kit/index.js'
import { LLM_KEY, startLlm } from './fixtures/llm.js'

const OWNER = 'owner-key-for-ai'
const llm = await startLlm()
afterAll(() => llm.close())
const app = await createApp({
  db: await testDb(),
  env: {
    API_KEYS: `owner:${hashApiKey(OWNER)}`,
    GATEWAY_MASTER_KEY: randomBytes(32).toString('base64'),
    GATEWAY_AI_GROUPING_WRITER_MODEL: 'writer-from-env',
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
const grouping = (json: any) => json.jobs.find((job: { job: string }) => job.job === 'grouping')
const builds = (json: any) => json.jobs.find((job: { job: string }) => job.job === 'builds')

describe('AI settings', () => {
  it('shows each job’s settings with where they come from, and no key', async () => {
    const { json } = await owner('/api/ai')
    const job = grouping(json)
    expect(job).toMatchObject({
      ready: false,
      provider: { value: 'openrouter', from: 'default', env: 'GATEWAY_AI_GROUPING_PROVIDER' },
      key: { set: false, from: 'default' },
      writerModel: { value: 'writer-from-env', from: 'env' },
      deciderModel: { value: 'typesafe/jev-1.14', from: 'default' },
      deciderProtocol: { value: 'typesafe', from: 'default' },
    })
    expect(json.jobs[0]).toMatchObject({ job: 'search', ready: false, key: { set: false, env: 'OPENROUTER_API_KEY' } })
    expect(json.providers.map((provider: { id: string }) => provider.id)).toEqual([
      'openrouter',
      'openai',
      'local',
      'custom',
    ])
  })

  it('refuses a build while Build with AI has no model to ask', async () => {
    await owner('/api/packs', { method: 'POST', body: { name: 'desk', title: 'Desk', description: 'Greets guests.' } })
    const body = { mode: 'build', tasks: ['greet a guest'] }
    for (const path of ['/api/packs/desk/builds/estimate', '/api/packs/desk/builds']) {
      const refused = await owner(path, { method: 'POST', body })
      expect([refused.status, refused.json.detail]).toEqual([
        409,
        'Build with AI has no model to ask: give it a key in Settings › AI (PATCH /api/ai/builds), or give smart grouping one, which it follows.',
      ])
    }
  })

  it('saves a provider, key and models that win over .env, sealed; null goes back to .env', async () => {
    const saved = await owner('/api/ai/grouping', {
      method: 'PATCH',
      body: {
        provider: 'custom',
        baseUrl: llm.baseUrl,
        key: LLM_KEY,
        writerModel: 'writer-1',
        deciderModel: 'decider-1',
      },
    })
    const job = grouping(saved.json)
    expect(job).toMatchObject({
      ready: true,
      key: { set: true, from: 'settings' },
      writerModel: { value: 'writer-1', from: 'settings' },
      deciderProtocol: { value: 'openai', from: 'default' },
    })
    expect(JSON.stringify(saved.json)).not.toContain(LLM_KEY)
    const back = await owner('/api/ai/grouping', { method: 'PATCH', body: { writerModel: null } })
    expect(grouping(back.json).writerModel).toMatchObject({ value: 'writer-from-env', from: 'env' })
    await owner('/api/ai/grouping', { method: 'PATCH', body: { writerModel: 'writer-1' } })
    expect((await owner('/api/ai/search', { method: 'PATCH', body: { writerModel: 'x' } })).status).toBe(400)
  })

  it('tests each model with one small call', async () => {
    const { json } = await owner('/api/ai/grouping/test', { method: 'POST' })
    expect(json.ok).toBe(true)
    expect(json.checks.map((check: { name: string; ok: boolean }) => [check.name, check.ok])).toEqual([
      ['Writer', true],
      ['Decider', true],
    ])
    expect(llm.asks.map((ask) => ask.model)).toEqual(['writer-1', 'decider-1'])
    const search = (await owner('/api/ai/search/test', { method: 'POST' })).json
    expect(search).toMatchObject({ ok: false, checks: [{ name: 'Embedding', ok: false }] })
    expect(search.checks[0].detail).toContain('OPENROUTER_API_KEY')
  })

  it('gives Build with AI its own model, following smart grouping for whatever it leaves unset', async () => {
    const follows = builds((await owner('/api/ai')).json)
    expect(follows).toMatchObject({
      job: 'builds',
      ready: true,
      provider: { value: 'custom', from: 'grouping', env: 'GATEWAY_AI_BUILDS_PROVIDER' },
      baseUrl: { value: llm.baseUrl, from: 'grouping', env: 'GATEWAY_AI_BUILDS_BASE_URL' },
      key: { set: true, from: 'grouping', env: 'GATEWAY_AI_BUILDS_KEY' },
      writerModel: { value: 'writer-1', from: 'grouping', env: 'GATEWAY_AI_BUILDS_MODEL' },
      model: null,
      deciderModel: null,
      deciderProtocol: null,
    })
    const own = builds((await owner('/api/ai/builds', { method: 'PATCH', body: { writerModel: 'decider-1' } })).json)
    expect(own.writerModel).toMatchObject({ value: 'decider-1', from: 'settings' })
    expect(own.key.from).toBe('grouping')
    expect(grouping((await owner('/api/ai')).json).writerModel.value).toBe('writer-1')
    const refused = await owner('/api/ai/builds', { method: 'PATCH', body: { deciderModel: 'decider-1' } })
    expect([refused.status, refused.json.detail]).toEqual([
      400,
      'Build with AI takes a provider, address, key and model here: it has no decider.',
    ])
  })

  it('tests the build model with one small call', async () => {
    const before = llm.asks.length
    const { json } = await owner('/api/ai/builds/test', { method: 'POST' })
    expect(json).toMatchObject({ job: 'builds', ok: true, checks: [{ name: 'Writer', ok: true }] })
    expect(llm.asks.slice(before).map((ask) => ask.model)).toEqual(['decider-1'])
    await owner('/api/ai/builds', { method: 'PATCH', body: { writerModel: null } })
  })

  it('estimates a build with the build job’s model, here grouping’s writer, with no price it can know', async () => {
    const { status, json } = await owner('/api/packs/desk/builds/estimate', {
      method: 'POST',
      body: { mode: 'build', tasks: ['greet a guest'] },
    })
    expect(status).toBe(200)
    expect(json).toMatchObject({ model: 'writer-1', usd: null, priceKnown: false })
  })

  it('lists the models a provider offers, filtered by words', async () => {
    const { json } = await owner('/api/ai/models?provider=custom&q=decider')
    expect(json.models.map((model: { id: string }) => model.id)).toEqual(['decider-1'])
  })

  it('lists the models Build with AI can reach, at its own address when it has one', async () => {
    // Following grouping, it lists what grouping's server offers
    const follows = await owner('/api/ai/models?job=builds&provider=custom&q=decider')
    expect(follows.json.models.map((model: { id: string }) => model.id)).toEqual(['decider-1'])
    // At an address of its own, it asks there and not grouping's server
    await owner('/api/ai/builds', { method: 'PATCH', body: { baseUrl: 'http://127.0.0.1:9/v1' } })
    const own = await owner('/api/ai/models?job=builds&provider=custom')
    expect(own.status).toBe(503)
    expect((await owner('/api/ai/models?provider=custom&q=decider')).status).toBe(200)
    await owner('/api/ai/builds', { method: 'PATCH', body: { baseUrl: null } })
  })
})
