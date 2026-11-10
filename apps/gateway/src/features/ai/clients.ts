/**
 * Talking to the configured models. The writer is any OpenAI-compatible chat model that answers JSON; the decider is
 * TypeSafe's System One API (labels chosen from fixed lists, with confidences) or, for another model, the same chat
 * call asked to choose. The model list feeds the Settings picker: OpenRouter's public catalogue, else `/models`.
 */
import { choice, type Question, TypeSafeClient } from '@typesafe-ai/sdk'
import { embedRequest } from '../../kit/vectors/index.js'
import type { GroupingConfig, SearchConfig } from './config.js'

const TIMEOUT_MS = 60_000

/** Problems with a model call, said for the owner. */
export class AiError extends Error {}

/** A chat completion that must answer JSON; returns it parsed. */
export const chatJson = async <T>(
  config: Pick<GroupingConfig, 'baseUrl' | 'key'>,
  model: string,
  system: string,
  user: string,
): Promise<T> => {
  const response = await fetch(`${config.baseUrl.value.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.key.value ? { authorization: `Bearer ${config.key.value}` } : {}),
      'x-title': 'Yardhand',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new AiError(`${model} could not be reached: ${error instanceof Error ? error.message : String(error)}`)
  })
  const body = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[]
    error?: { message?: string }
  } | null
  if (!response.ok)
    throw new AiError(`${model} answered ${response.status}: ${body?.error?.message ?? 'no reason given'}`)
  const text = body?.choices?.[0]?.message?.content ?? ''
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as T
  } catch {
    throw new AiError(`${model} didn't answer JSON: ${text.slice(0, 160)}`)
  }
}

/** A choice per question: the label picked for each, keyed like the questions. */
export type Choices = Record<string, { choice: string; confidence: number }>

/**
 * Asks the decider to choose: each question picks one label from its own list. TypeSafe answers with probabilities;
 * a chat model is asked for JSON and trusted at 0.5.
 */
export const decide = async (
  config: Pick<GroupingConfig, 'baseUrl' | 'key' | 'deciderModel' | 'deciderProtocol'>,
  state: Record<string, unknown>,
  questions: Record<string, { instructions: string; labels: Record<string, string> }>,
): Promise<Choices> => {
  if (config.deciderProtocol.value === 'typesafe') {
    const client = new TypeSafeClient({
      apiKey: config.key.value,
      // TypeSafe's SDK adds its own version path to the base
      baseURL: config.baseUrl.value.replace(/\/v1\/?$/, ''),
      defaultModel: config.deciderModel.value,
      timeout: TIMEOUT_MS,
      logLevel: 'off',
    })
    const asked = Object.fromEntries(
      Object.entries(questions).map(([name, question]) => [name, choice(question.instructions, question.labels)]),
    ) as Record<string, Question>
    const { answers } = await client.systemOne({ state: state as never, questions: asked }).catch((error: unknown) => {
      throw new AiError(
        `${config.deciderModel.value} could not decide: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    return Object.fromEntries(
      Object.entries(answers as Record<string, { choice?: string; confidence?: number }>).map(([name, answer]) => [
        name,
        { choice: String(answer.choice ?? ''), confidence: Number(answer.confidence ?? 0) },
      ]),
    )
  }
  const answer = await chatJson<Record<string, string>>(
    config,
    config.deciderModel.value,
    'You choose. For each question, answer with exactly one of its labels. Reply as JSON: {"<question>": "<label>"}.',
    JSON.stringify({
      state,
      questions: Object.fromEntries(
        Object.entries(questions).map(([name, question]) => [
          name,
          { question: question.instructions, labels: question.labels },
        ]),
      ),
    }),
  )
  return Object.fromEntries(
    Object.keys(questions).map((name) => [name, { choice: String(answer[name] ?? ''), confidence: 0.5 }]),
  )
}

export type TestResult = { ok: boolean; ms: number; detail: string }

const timed = async (run: () => Promise<string>): Promise<TestResult> => {
  const started = Date.now()
  try {
    const detail = await run()
    return { ok: true, ms: Date.now() - started, detail }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** One small call per model, to show a job works before relying on it. */
export const testSearch = (config: SearchConfig) =>
  timed(async () => {
    if (!config.key.value) throw new AiError('No key: set one here, or OPENROUTER_API_KEY in .env.')
    const { vectors } = await embedRequest(config.key.value, ['find a quick dinner recipe'])
    return `Embedded a sentence into ${vectors[0]?.length ?? 0} numbers.`
  })

export const testGrouping = async (config: GroupingConfig) => {
  const writer = await timed(async () => {
    const answer = await chatJson<{ ok?: unknown }>(
      config,
      config.writerModel.value,
      'You check a connection. Reply with exactly this JSON object and nothing else: {"ok": true}',
      'Check.',
    )
    if (answer.ok !== true && answer.ok !== 'true')
      throw new AiError(
        `${config.writerModel.value} answered ${JSON.stringify(answer).slice(0, 80)}, not {"ok": true}.`,
      )
    return `${config.writerModel.value} answered JSON.`
  })
  const decider = await timed(async () => {
    const picked = await decide(
      config,
      { tools: ['list_menus', 'create_menu'] },
      { pick: { instructions: 'Which group holds list_menus?', labels: { menus: 'Menus', recipes: 'Recipes' } } },
    )
    if (picked.pick?.choice !== 'menus')
      throw new AiError(`${config.deciderModel.value} chose ${picked.pick?.choice || 'nothing'} instead of menus.`)
    return `${config.deciderModel.value} filed a tool correctly${config.deciderProtocol.value === 'typesafe' ? ` (${Math.round((picked.pick?.confidence ?? 0) * 100)}% sure)` : ''}.`
  })
  return { ok: writer.ok && decider.ok, writer, decider }
}

/** A model for the picker. */
export type ModelCard = {
  id: string
  name: string
  contextLength: number | null
  /** USD per million tokens, in and out. */
  price: { input: number; output: number } | null
  pinned: boolean
}

/** TypeSafe's decision models: not in OpenRouter's public catalogue, but served through it. */
const TYPESAFE_MODELS: ModelCard[] = [
  { id: 'typesafe/jev-1.14', name: 'TypeSafe: Jev 1.14 (decides)', contextLength: null, price: null, pinned: true },
]

let catalogue: { at: number; models: ModelCard[] } | null = null

/** Models to pick from: OpenRouter's catalogue (cached an hour) with TypeSafe's first, else the server's `/models`. */
export const listModels = async (config: Pick<GroupingConfig, 'provider' | 'baseUrl' | 'key'>) => {
  if (config.provider.value === 'openrouter') {
    if (!catalogue || Date.now() - catalogue.at > 3_600_000) {
      const response = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(TIMEOUT_MS) })
      const body = (await response.json().catch(() => ({}))) as {
        data?: {
          id: string
          name?: string
          context_length?: number
          pricing?: { prompt?: string; completion?: string }
          architecture?: { output_modalities?: string[] }
        }[]
      }
      if (!response.ok || !body.data) throw new AiError(`OpenRouter's model list answered ${response.status}.`)
      catalogue = {
        at: Date.now(),
        models: body.data
          .filter((model) => (model.architecture?.output_modalities ?? ['text']).includes('text'))
          .map((model) => ({
            id: model.id,
            name: model.name ?? model.id,
            contextLength: model.context_length ?? null,
            price:
              model.pricing?.prompt !== undefined
                ? {
                    input: Number(model.pricing.prompt) * 1_000_000,
                    output: Number(model.pricing.completion ?? 0) * 1_000_000,
                  }
                : null,
            pinned: false,
          })),
      }
    }
    return [...TYPESAFE_MODELS, ...catalogue.models]
  }
  const response = await fetch(`${config.baseUrl.value.replace(/\/$/, '')}/models`, {
    headers: config.key.value ? { authorization: `Bearer ${config.key.value}` } : {},
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw new AiError(
      `${config.baseUrl.value} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
  const body = (await response.json().catch(() => ({}))) as { data?: { id: string }[] }
  if (!response.ok) throw new AiError(`${config.baseUrl.value}/models answered ${response.status}.`)
  return (body.data ?? []).map((model) => ({
    id: model.id,
    name: model.id,
    contextLength: null,
    price: null,
    pinned: false,
  }))
}
