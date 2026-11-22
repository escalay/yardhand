/**
 * A scripted model for Build with AI, for tests and the demo: no provider, no network. It answers each ask by its
 * `step`: an answer given as a value is used every time, one given as a list is used in turn (the last one again
 * once it runs out), and one given as a function is called with the ask and how many asks of that step came before.
 * `asks` records every ask. It reports `costUsd` a call (null: no cost reported) and `price` as its list price (null:
 * none published); `refuse` makes it throw the kit's `SpendCapError` from that ask on (1 is the first); `shape:
 * 'wrong'` answers every ask with something no step takes.
 */
import type { Ask, AskStep, Model, Price } from '../../src/features/ai/model.js'
import { SpendCapError } from '../../src/kit/vectors/index.js'

type Answer = unknown | unknown[] | ((ask: Ask, count: number) => unknown)

const SKILL = [
  '## What it is for',
  'Trying the pack.',
  '## Which tool for which job',
  'Each tool says what it does.',
  '## Values already set',
  'None.',
  '## Playbooks',
  'One a task.',
  '## Gotchas',
  'None known.',
  "## What it can't do",
  'Anything its tools don’t.',
].join('\n')

const DEFAULTS: Record<AskStep, Answer> = {
  kit: { tools: [], skipped: [], variables: [], inputs: [] },
  playbook: (_ask: Ask, count: number) => ({
    name: `task-${count + 1}`,
    markdown: `---\ntitle: Task ${count + 1}\ndescription: One of the example tasks.\n---\n\n1. Do it.\n`,
  }),
  skill: { markdown: SKILL },
  repair: { playbooks: [], skill: null },
  rehearse: { done: true, outcome: 'Done.' },
}

export const fakeModel = ({
  name = 'fake/writer',
  ready = true,
  price = { input: 1, output: 1 },
  costUsd = null,
  refuse,
  shape = 'right',
  ...answers
}: Partial<Record<AskStep, Answer>> & {
  name?: string
  ready?: boolean
  price?: Price | null
  costUsd?: number | null
  refuse?: number
  shape?: 'right' | 'wrong'
} = {}) => {
  const asks: Ask[] = []
  const counts = new Map<AskStep, number>()
  const answerOf = (ask: Ask) => {
    const count = counts.get(ask.step) ?? 0
    counts.set(ask.step, count + 1)
    if (shape === 'wrong') return { nonsense: true }
    const answer = answers[ask.step] ?? DEFAULTS[ask.step]
    if (typeof answer === 'function') return (answer as (ask: Ask, count: number) => unknown)(ask, count)
    if (Array.isArray(answer)) return answer[Math.min(count, answer.length - 1)]
    return answer
  }
  const model: Model = {
    name: async () => name,
    ready: async () => ready,
    price: async () => price,
    ask: async (ask) => {
      asks.push(ask)
      if (refuse !== undefined && asks.length >= refuse) throw new SpendCapError('fake model: 402, credit used up')
      const json = answerOf(ask)
      return {
        json,
        usage: {
          inputTokens: Math.ceil((ask.system.length + ask.user.length) / 4),
          outputTokens: Math.ceil(JSON.stringify(json).length / 4),
          costUsd,
        },
      }
    },
  }
  return Object.assign(model, { asks })
}
