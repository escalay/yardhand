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

  it('lists the models a provider offers, filtered by words', async () => {
    const { json } = await owner('/api/ai/models?provider=custom&q=decider')
    expect(json.models.map((model: { id: string }) => model.id)).toEqual(['decider-1'])
  })
})
