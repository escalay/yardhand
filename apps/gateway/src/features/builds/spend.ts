/**
 * What a build may spend on its model, and the estimate shown before it starts. The cap holds before every ask: what
 * is spent plus the larger of the ask's list-price worst case and the dearest call seen so far, so a provider that
 * charges above list price overshoots by one call at most. Cost is what the provider reported, else list price times
 * tokens; with neither, a build is held to a token budget instead (what $1 buys at $2.50 a million).
 */
import type { Usage } from '../ai/clients.js'
import type { AskStep, Price } from '../ai/model.js'

export const BUILD_CAP_USD = 1
export const TOKEN_BUDGET = 400_000
/** The most each ask may answer, in tokens. */
export const MAX_TOKENS: Record<AskStep, number> = {
  kit: 4000,
  playbook: 1500,
  skill: 2500,
  repair: 4000,
  rehearse: 400,
}
/** The most model asks a rehearsal makes for one task, and so the most real read calls. */
export const REHEARSAL_STEPS = 6
/** The most tools a build looks at. */
export const CANDIDATES = 60
const CHARS_PER_TOKEN = 4

const costOf = (price: Price, inputTokens: number, outputTokens: number) =>
  (inputTokens * price.input + outputTokens * price.output) / 1_000_000

export type Spent = { usd: number; tokens: number; modelCalls: number; known: boolean }

export const createSpend = ({
  capUsd,
  price,
  tokenBudget,
}: {
  capUsd: number
  price: Price | null
  tokenBudget: number
}) => {
  let usd = 0
  let tokens = 0
  let modelCalls = 0
  let dearest = 0
  let reported = false
  return {
    /** May the build make this ask? */
    affords: ({ inputChars, maxTokens }: { inputChars: number; maxTokens: number }) => {
      const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN)
      if (!price && !reported) return tokens + inputTokens + maxTokens <= tokenBudget
      const worst = price ? costOf(price, inputTokens, maxTokens) : 0
      return usd + Math.max(worst, dearest) <= capUsd
    },
    /** Counts one answered ask. */
    add: (usage: Usage) => {
      modelCalls++
      tokens += usage.inputTokens + usage.outputTokens
      if (usage.costUsd !== null) reported = true
      const cost = usage.costUsd ?? (price ? costOf(price, usage.inputTokens, usage.outputTokens) : 0)
      usd += cost
      dearest = Math.max(dearest, cost)
    },
    /** `known`: the dollars are real (a list price or a reported cost), not only tokens. */
    spent: (): Spent => ({ usd, tokens, modelCalls, known: Boolean(price) || reported }),
  }
}

export type Spend = ReturnType<typeof createSpend>

/** What each ask is likely to send, in characters, before the tasks' own words. */
const INPUT_CHARS: Record<AskStep, number> = {
  kit: 3000 + CANDIDATES * 700,
  playbook: 8000,
  skill: 10_000,
  repair: 10_000,
  rehearse: 6000,
}

/**
 * The likely cost of a build, with no search and no request: the kit at the candidate ceiling, a playbook a task,
 * the skill, one repair, and the rehearsal at half its steps a task, each answer at half its most.
 */
export const estimateOf = ({ tasks, price }: { tasks: string[]; price: Price | null }) => {
  const taskChars = tasks.join('\n').length
  const likelyRehearsal = REHEARSAL_STEPS / 2
  const asks: [AskStep, number][] = [
    ['kit', 1],
    ['playbook', tasks.length],
    ['skill', 1],
    ['repair', 1],
    ['rehearse', likelyRehearsal * tasks.length],
  ]
  let input = 0
  let output = 0
  for (const [step, count] of asks) {
    input += count * Math.ceil((INPUT_CHARS[step] + taskChars) / CHARS_PER_TOKEN)
    output += count * (MAX_TOKENS[step] / 2)
  }
  const fixed = 1 + tasks.length + 1 + 1
  return {
    usd: price ? costOf(price, input, output) : null,
    tokens: input + output,
    modelCalls: { likely: fixed + likelyRehearsal * tasks.length, max: fixed + REHEARSAL_STEPS * tasks.length },
  }
}
