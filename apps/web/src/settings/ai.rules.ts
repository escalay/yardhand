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

const own = (from: Job['provider']['from']) => from === 'settings' || from === 'env'

/**
 * Build with AI sets a provider, address or key of its own, so all three are its own and smart grouping's key is
 * never sent there, but it can't reach a model yet (no key, or no address).
 */
export const ownConnectionUnreachable = (job: Pick<Job, 'ready' | 'provider' | 'baseUrl' | 'key'>) =>
  !job.ready && [job.provider.from, job.baseUrl.from, job.key.from].some(own)

/** A time ahead in words: "in 5 min", "in 2 h", "soon". */
const inTime = (iso: string, now: number) => {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000)
  return minutes < 1 ? 'soon' : minutes < 90 ? `in ${minutes} min` : `in ${Math.round(minutes / 60)} h`
}

/**
 * What to know about search by meaning's vectors, or null when every tool has one: how many are found by their words
 * only, and when a refresh that did not finish is tried again.
 */
export const vectorsLine = (vectors: Job['vectors'], now = Date.now()) => {
  if (!vectors || (!vectors.missing && !vectors.failed)) return null
  const one = vectors.missing === 1
  const missing = vectors.missing
    ? `${vectors.missing.toLocaleString('en-GB')} of ${vectors.tools.toLocaleString('en-GB')} tools ${one ? 'has' : 'have'} no vector yet, so search finds ${one ? 'it by its' : 'them by their'} words only.`
    : ''
  const next = vectors.failed
    ? `The last refresh did not finish (${vectors.failed}); it tries again ${vectors.retryAt ? inTime(vectors.retryAt, now) : 'at the next change'}.`
    : `${one ? 'It gets' : 'They get'} one at the next refresh.`
  return [missing, next].filter(Boolean).join(' ')
}
