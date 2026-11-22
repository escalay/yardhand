/**
 * The model a build asks (Build with AI's job): one chat call per ask, answering JSON with what it used and cost.
 * Tests and the demo pass a scripted one to `createApp`, so neither reaches a provider.
 */
import { chat, listModels, type Usage } from './clients.js'
import type { BuildsConfig } from './config.js'

/** What a build asks for: the pack's kit, a playbook per task, the skill, one repair, a rehearsal's next step. */
export type AskStep = 'kit' | 'playbook' | 'skill' | 'repair' | 'rehearse'
export type Ask = { step: AskStep; system: string; user: string; maxTokens: number }
/** USD per million tokens, in and out. */
export type Price = { input: number; output: number }

export type Model = {
  /** The model's id, as the estimate and the proposal name it. */
  name(): Promise<string>
  /** It has what it needs to run (a key, unless the server is local). */
  ready(): Promise<boolean>
  /** Its list price; null when the provider publishes none or its list can't be read. Never throws. */
  price(): Promise<Price | null>
  /** One ask. A 402 or 403 throws the kit's `SpendCapError`; an answer that isn't JSON an `AiError` with its `usage`. */
  ask(ask: Ask): Promise<{ json: unknown; usage: Usage }>
}

/** The build job's model, read from its settings on every ask, so a change in Settings › AI applies at once. */
export const buildsModel = (ai: { builds: () => Promise<BuildsConfig> }): Model => ({
  name: async () => (await ai.builds()).writerModel.value,
  ready: async () => (await ai.builds()).ready,
  price: async () => {
    const config = await ai.builds()
    if (config.provider.value !== 'openrouter') return null
    const models = await listModels(config).catch(() => [])
    return models.find((model) => model.id === config.writerModel.value)?.price ?? null
  },
  ask: async ({ system, user, maxTokens }) => {
    const config = await ai.builds()
    return chat(config, config.writerModel.value, { system, user, maxTokens })
  },
})
