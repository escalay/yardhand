import { describe, expect, it } from 'vitest'
import { applyChange, protocolFor, resolveGrouping, resolveSearch } from './config.js'

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
