/** A chat call that says what it cost: tokens both ways and the provider's own figure, when it gives one. */
import { afterAll, describe, expect, it } from 'vitest'
import { LLM_KEY, startLlm } from '../../../test/fixtures/llm.js'
import { SpendCapError } from '../../kit/vectors/index.js'
import { AiError, chat, chatJson } from './clients.js'

const llm = await startLlm()
afterAll(() => llm.close())
const config = {
  provider: { value: 'custom' as const, from: 'settings' as const },
  baseUrl: { value: llm.baseUrl, from: 'settings' as const },
  key: { value: LLM_KEY, from: 'settings' as const },
}

describe('chat', () => {
  it('answers parsed JSON with the tokens used and the cost the provider reported', async () => {
    llm.state.usage = { prompt_tokens: 120, completion_tokens: 30, cost: 0.0021 }
    const answer = await chat(config, 'writer-1', { system: 'Check.', user: 'Check.', maxTokens: 400 })
    expect(answer).toEqual({ json: { ok: true }, usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.0021 } })
    expect(llm.asks.at(-1)?.body).toMatchObject({ model: 'writer-1', max_tokens: 400 })
    // Only OpenRouter is asked to report the cost
    expect(llm.asks.at(-1)?.body.usage).toBeUndefined()
  })

  it('reports no cost when the provider gives none, and asks OpenRouter for it', async () => {
    llm.state.usage = { prompt_tokens: 10, completion_tokens: 5 }
    const answer = await chat(config, 'writer-1', { system: 'Check.', user: 'Check.', maxTokens: 50 })
    expect(answer.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: null })
    await chat({ ...config, provider: { value: 'openrouter', from: 'settings' } }, 'writer-1', {
      system: 'Check.',
      user: 'Check.',
      maxTokens: 50,
    })
    expect(llm.asks.at(-1)?.body.usage).toEqual({ include: true })
    llm.state.usage = null
  })

  it('counts what it sent and the most it may answer when the provider reports no usage', async () => {
    llm.state.usage = null
    // 12 characters sent are 3 tokens at four a token; the answer counts as its 50 at most
    const answer = await chat(config, 'writer-1', { system: 'Check.', user: 'Check.', maxTokens: 50 })
    expect(answer.usage).toEqual({ inputTokens: 3, outputTokens: 50, costUsd: null })
  })

  it('throws the kit’s SpendCapError on a 402 or 403, and AiError on any other refusal', async () => {
    const ask = () => chat(config, 'writer-1', { system: 'Check.', user: 'Check.', maxTokens: 50 })
    for (const status of [402, 403]) {
      llm.state.refuse = status
      await expect(ask()).rejects.toBeInstanceOf(SpendCapError)
    }
    llm.state.refuse = 500
    await expect(ask()).rejects.toBeInstanceOf(AiError)
    // Smart grouping keeps today's errors: any refusal, a 402 too, is an AiError
    llm.state.refuse = 402
    await expect(chatJson(config, 'writer-1', 'Check.', 'Check.')).rejects.toBeInstanceOf(AiError)
    llm.state.refuse = null
    await expect(chatJson(config, 'writer-1', 'Check.', 'Check.')).resolves.toEqual({ ok: true })
  })
})
