/**
 * The gateway's AI jobs and where each setting comes from. `.env` gives the starting values; a value saved in Settings
 * is sealed in the vault and wins; a default fills the rest. A key never leaves: only whether it is set, and from where.
 *
 * - `search`: search by meaning. Its embeddings come from agent-api-kit (OpenRouter, Gemini Embedding 2), so only its
 *   key is set here; a new model would throw away every stored vector.
 * - `grouping`: smart grouping. A writer names a connection's groups (any OpenAI-compatible chat model); a decider
 *   files each tool in one (TypeSafe's System One API, e.g. `typesafe/jev-1.14`, or a plain chat model).
 */

export const AI_JOBS = ['search', 'grouping'] as const
export type AiJob = (typeof AI_JOBS)[number]
export const PROVIDERS = {
  openrouter: { title: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  openai: { title: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  local: { title: 'Local (Ollama, LM Studio)', baseUrl: 'http://localhost:11434/v1' },
  custom: { title: 'Another OpenAI-compatible server', baseUrl: '' },
} as const
export type Provider = keyof typeof PROVIDERS
export type DeciderProtocol = 'typesafe' | 'openai'

/** What the owner can set per job; a missing field follows `.env`, then the default. */
export type AiSettings = {
  provider?: Provider
  baseUrl?: string
  key?: string
  writerModel?: string
  deciderModel?: string
  deciderProtocol?: DeciderProtocol
}

export const EMBEDDING_MODEL = 'google/gemini-embedding-2 (set by agent-api-kit)'
const DEFAULTS = {
  grouping: {
    provider: 'openrouter' as Provider,
    writerModel: 'google/gemini-3.5-flash-lite',
    deciderModel: 'typesafe/jev-1.14',
  },
}

export type Env = Record<string, string | undefined>
export type From = 'settings' | 'env' | 'default'
export type Field<T> = { value: T; from: From }

/** The env names each job reads. */
export const ENV_NAMES = {
  search: { key: 'OPENROUTER_API_KEY' },
  grouping: {
    provider: 'GATEWAY_AI_GROUPING_PROVIDER',
    baseUrl: 'GATEWAY_AI_GROUPING_BASE_URL',
    key: 'GATEWAY_AI_GROUPING_KEY',
    writerModel: 'GATEWAY_AI_GROUPING_WRITER_MODEL',
    deciderModel: 'GATEWAY_AI_GROUPING_DECIDER_MODEL',
    deciderProtocol: 'GATEWAY_AI_GROUPING_DECIDER_PROTOCOL',
  },
} as const

const pick = <T>(saved: T | undefined, fromEnv: T | undefined, fallback: T): Field<T> =>
  saved !== undefined && saved !== ''
    ? { value: saved, from: 'settings' }
    : fromEnv !== undefined && fromEnv !== ''
      ? { value: fromEnv, from: 'env' }
      : { value: fallback, from: 'default' }

const isProvider = (value: string | undefined): value is Provider => Boolean(value && value in PROVIDERS)

/** Providers that serve TypeSafe's System One API (through OpenRouter, or a server of your own). */
export const servesTypeSafe = (provider: Provider) => provider === 'openrouter' || provider === 'custom'

/** A decider speaks TypeSafe's System One API when its model is TypeSafe's, else plain chat. */
export const protocolFor = (model: string): DeciderProtocol => (model.startsWith('typesafe/') ? 'typesafe' : 'openai')

/** The search job as it stands: its key, and the kit's fixed model. */
export const resolveSearch = (saved: AiSettings | undefined, env: Env) => {
  const key = pick(saved?.key, env[ENV_NAMES.search.key], '')
  return {
    job: 'search' as const,
    provider: { value: 'openrouter' as Provider, from: 'default' as From },
    baseUrl: { value: PROVIDERS.openrouter.baseUrl, from: 'default' as From },
    key,
    model: { value: EMBEDDING_MODEL, from: 'default' as From },
    ready: Boolean(key.value),
  }
}

/** The grouping job as it stands, each field with where it comes from. */
export const resolveGrouping = (saved: AiSettings | undefined, env: Env) => {
  const names = ENV_NAMES.grouping
  const envProvider = env[names.provider]
  const provider = pick<Provider>(
    saved?.provider,
    isProvider(envProvider) ? envProvider : undefined,
    DEFAULTS.grouping.provider,
  )
  const baseUrl = pick(saved?.baseUrl, env[names.baseUrl], PROVIDERS[provider.value].baseUrl)
  const key = pick(saved?.key, env[names.key], '')
  const writerModel = pick(saved?.writerModel, env[names.writerModel], DEFAULTS.grouping.writerModel)
  // OpenAI or a local server can't serve TypeSafe's decisions: the decider is a chat model there, the writer's by default
  const typesafe = servesTypeSafe(provider.value)
  const deciderModel = pick(
    saved?.deciderModel,
    env[names.deciderModel],
    typesafe ? DEFAULTS.grouping.deciderModel : writerModel.value,
  )
  const envProtocol = env[names.deciderProtocol]
  const chosenProtocol = pick<DeciderProtocol>(
    saved?.deciderProtocol,
    envProtocol === 'typesafe' || envProtocol === 'openai' ? envProtocol : undefined,
    protocolFor(deciderModel.value),
  )
  const deciderProtocol: Field<DeciderProtocol> =
    typesafe || chosenProtocol.value === 'openai' ? chosenProtocol : { value: 'openai', from: 'default' }
  // A local server needs no key
  const ready = Boolean(baseUrl.value) && (Boolean(key.value) || provider.value === 'local')
  return { job: 'grouping' as const, provider, baseUrl, key, writerModel, deciderModel, deciderProtocol, ready }
}

export type SearchConfig = ReturnType<typeof resolveSearch>
export type GroupingConfig = ReturnType<typeof resolveGrouping>

/** Saved settings after a change: `null` drops a field back to `.env`; an unchanged field stays. */
export const applyChange = (
  saved: AiSettings | undefined,
  change: { [K in keyof AiSettings]?: AiSettings[K] | null },
) => {
  const next: AiSettings = { ...(saved ?? {}) }
  for (const [field, value] of Object.entries(change) as [keyof AiSettings, string | null | undefined][]) {
    if (value === undefined) continue
    if (value === null || value === '') delete next[field]
    else (next as Record<string, string>)[field] = value
  }
  return next
}
