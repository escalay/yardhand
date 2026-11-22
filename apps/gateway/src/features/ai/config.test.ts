import { describe, expect, it } from 'vitest'
import { applyChange, protocolFor, resolveBuilds, resolveGrouping, resolveSearch } from './config.js'

describe('AI settings', () => {
  it('takes Settings over .env over the defaults, and says where each came from', () => {
    const fromEnv = resolveGrouping(undefined, {
      GATEWAY_AI_GROUPING_KEY: 'env-key',
      GATEWAY_AI_GROUPING_WRITER_MODEL: 'w',
    })
    expect(fromEnv.key).toEqual({ value: 'env-key', from: 'env' })
    expect(fromEnv.writerModel).toEqual({ value: 'w', from: 'env' })
    expect(fromEnv.deciderModel).toEqual({ value: 'typesafe/jev-1.14', from: 'default' })
    expect(fromEnv.deciderProtocol).toEqual({ value: 'typesafe', from: 'default' })
    expect(fromEnv.baseUrl.value).toBe('https://openrouter.ai/api/v1')
    expect(fromEnv.ready).toBe(true)
    const saved = resolveGrouping({ provider: 'local', deciderModel: 'qwen3' }, { GATEWAY_AI_GROUPING_KEY: 'env-key' })
    expect(saved.baseUrl).toEqual({ value: 'http://localhost:11434/v1', from: 'default' })
    expect(saved.deciderProtocol.value).toBe('openai')
    expect(resolveGrouping(undefined, {}).ready).toBe(false)
    expect(resolveSearch(undefined, { OPENROUTER_API_KEY: 'k' }).key.from).toBe('env')
  })

  it('drops a field back to .env with null, and keeps what the change leaves out', () => {
    expect(applyChange({ key: 'a', writerModel: 'w' }, { key: null, deciderModel: 'd' })).toEqual({
      writerModel: 'w',
      deciderModel: 'd',
    })
    expect(protocolFor('typesafe/jev-1.14')).toBe('typesafe')
    expect(protocolFor('google/gemini-3.5-flash-lite')).toBe('openai')
  })

  it('makes the decider a chat model where TypeSafe isn’t served', () => {
    const openai = resolveGrouping({ provider: 'openai' }, {})
    expect(openai.deciderProtocol.value).toBe('openai')
    expect(openai.deciderModel.value).toBe('google/gemini-3.5-flash-lite')
    expect(resolveGrouping({ provider: 'openai', deciderModel: 'typesafe/jev-1.14' }, {}).deciderProtocol.value).toBe(
      'openai',
    )
    expect(resolveGrouping({ provider: 'custom' }, {}).deciderProtocol.value).toBe('typesafe')
  })
})

describe('the build job’s settings', () => {
  const env = {
    GATEWAY_AI_GROUPING_PROVIDER: 'custom',
    GATEWAY_AI_GROUPING_BASE_URL: 'http://models.local/v1',
    GATEWAY_AI_GROUPING_KEY: 'grouping-key',
    GATEWAY_AI_GROUPING_WRITER_MODEL: 'small-writer',
  }
  const builds = (saved: Parameters<typeof resolveBuilds>[0], more: Record<string, string> = {}) =>
    resolveBuilds(saved, { ...env, ...more }, resolveGrouping(undefined, { ...env, ...more }))

  it('follows smart grouping field by field while it sets nothing of its own', () => {
    const job = builds(undefined)
    expect(job.provider).toEqual({ value: 'custom', from: 'grouping' })
    expect(job.baseUrl).toEqual({ value: 'http://models.local/v1', from: 'grouping' })
    expect(job.key).toEqual({ value: 'grouping-key', from: 'grouping' })
    expect(job.writerModel).toEqual({ value: 'small-writer', from: 'grouping' })
    expect(job.ready).toBe(true)
  })

  it('takes its own model from Settings over .env, and keeps following grouping for the rest', () => {
    expect(builds(undefined, { GATEWAY_AI_BUILDS_MODEL: 'strong-writer' }).writerModel).toEqual({
      value: 'strong-writer',
      from: 'env',
    })
    const job = builds({ writerModel: 'stronger-writer' }, { GATEWAY_AI_BUILDS_MODEL: 'strong-writer' })
    expect(job.writerModel).toEqual({ value: 'stronger-writer', from: 'settings' })
    expect(job.key.from).toBe('grouping')
  })

  it('takes a provider’s own address with its own provider, never grouping’s', () => {
    const job = builds({ provider: 'openai' })
    expect(job.provider).toEqual({ value: 'openai', from: 'settings' })
    expect(job.baseUrl).toEqual({ value: 'https://api.openai.com/v1', from: 'default' })
    // Field by field: a key it doesn't set is still grouping's, wherever its own address points
    expect(job.key).toEqual({ value: 'grouping-key', from: 'grouping' })
    expect(builds({ key: 'own-key' }).key).toEqual({ value: 'own-key', from: 'settings' })
  })

  it('says default where grouping itself only has a default, and is not ready without a key', () => {
    const bare = resolveBuilds(undefined, {}, resolveGrouping(undefined, {}))
    expect(bare.provider).toEqual({ value: 'openrouter', from: 'default' })
    expect(bare.writerModel).toEqual({ value: 'google/gemini-3.5-flash-lite', from: 'default' })
    expect(bare.key).toEqual({ value: '', from: 'default' })
    expect(bare.ready).toBe(false)
    expect(resolveBuilds({ provider: 'local' }, {}, resolveGrouping(undefined, {})).ready).toBe(true)
  })
})
