/** Pure rules for Settings › AI: a model's price and size in words, and where a setting comes from. */
import type { Schemas } from '@/api/client'

type Model = Schemas['AiModel']

/** "$0.30 in · $2.50 out per M tokens", or empty when the provider doesn't say. */
export const priceLine = (model: Pick<Model, 'price'>) =>
  model.price
    ? `$${model.price.input < 0.01 ? model.price.input.toFixed(3) : model.price.input.toFixed(2)} in · $${model.price.output.toFixed(2)} out per M tokens`
    : ''

/** "1M context", "128k context", or empty. */
export const contextLine = (model: Pick<Model, 'contextLength'>) =>
  model.contextLength
    ? model.contextLength >= 1_000_000
      ? `${Math.round(model.contextLength / 100_000) / 10}M context`
      : `${Math.round(model.contextLength / 1000)}k context`
    : ''

/** Where to get a key for a provider, for the setup's second step. */
export const KEY_HELP: Record<Schemas['AiJob']['provider']['value'], { url: string | null; text: string }> = {
  openrouter: {
    url: 'https://openrouter.ai/settings/keys',
    text: 'Make a key with a small monthly limit, e.g. "Yardhand · grouping" at $2.',
  },
  openai: {
    url: 'https://platform.openai.com/api-keys',
    text: 'A project key works; set a usage limit on the project.',
  },
  local: { url: null, text: 'A local server usually needs no key: leave it empty.' },
  custom: { url: null, text: 'The key your server expects as a bearer token.' },
}

/** Where Settings › AI keeps the card for Build with AI's model. */
export const BUILDS_CARD_ID = 'build-with-ai'

type Job = Schemas['AiJob']

export const sourceLabel = (from: Job['provider']['from']) =>
  from === 'settings' ? 'Set here' : from === 'env' ? '.env' : from === 'grouping' ? 'Smart grouping' : 'Default'

/** Build with AI runs on a provider or address of its own while its key is still smart grouping's. */
export const groupingKeySentElsewhere = (job: Pick<Job, 'provider' | 'baseUrl' | 'key'>) => {
  const own = (from: Job['provider']['from']) => from === 'settings' || from === 'env'
  return job.key.from === 'grouping' && (own(job.provider.from) || own(job.baseUrl.from))
}
