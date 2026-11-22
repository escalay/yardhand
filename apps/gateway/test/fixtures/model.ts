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

type Shown = { name: string; description?: string; changesThings?: boolean; inputSchema?: Record<string, unknown> }

const wordsOf = (text: string) => new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? [])
/** How many words of the tasks a tool's name and description share. */
const overlap = (tool: Shown, tasks: Set<string>) =>
  [...wordsOf(`${tool.name.replace(/[._-]/g, ' ')} ${tool.description ?? ''}`)].filter((word) =>
    [...tasks].some((task) => task.startsWith(word) || word.startsWith(task)),
  ).length
/** A tool's arguments for a task: the task as every string it requires, 1 as every number. */
const argumentsFor = (tool: Shown, task: string) => {
  const schema = tool.inputSchema ?? {}
  const properties = (schema.properties ?? {}) as Record<string, { type?: string }>
  const required = (schema.required ?? []) as string[]
  return Object.fromEntries(
    required.flatMap((input): [string, unknown][] =>
      properties[input]?.type === 'string' ? [[input, task]] : properties[input]?.type === 'number' ? [[input, 1]] : [],
    ),
  )
}
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * The demo's model: a pack drafted from what each ask shows, for any pack. The kit adds the one candidate that reads
 * and best matches the tasks, skips one that changes things, and declares `tone`; a playbook a task runs the pack's
 * first tool that reads (one it held, when it held one, so the line stands alone); the skill names every tool and
 * `{{tone}}`; a rehearsal runs that first tool, then tries one that changes things (handed a stand-in), then is done.
 * Priced as a mid-range model, so the estimate is a figure.
 */
export const demoModel = () =>
  fakeModel({
    name: 'demo/pack-writer',
    price: { input: 3, output: 15 },
    kit: (ask: Ask) => {
      const said = JSON.parse(ask.user) as {
        tasks: string[]
        pack_as_it_is: { tools: (string | { name: string })[] }
        candidates: Shown[]
      }
      const held = new Set(said.pack_as_it_is.tools.map((tool) => (typeof tool === 'string' ? tool : tool.name)))
      const tasks = wordsOf(said.tasks.join(' '))
      const fresh = said.candidates.filter((tool) => !held.has(tool.name))
      const [best] = fresh
        .filter((tool) => !tool.changesThings)
        .map((tool, order) => ({ tool, order, score: overlap(tool, tasks) }))
        .sort((a, b) => b.score - a.score || a.order - b.order)
      const risky = fresh.find((tool) => tool.changesThings)
      return {
        tools: best
          ? [{ name: best.tool.name, reason: `It reads what “${said.tasks[0]}” needs, and changes nothing.` }]
          : [],
        skipped: risky ? [{ name: risky.name, reason: 'It changes things, and no task needs that.' }] : [],
        variables: [{ name: 'tone', value: 'plain', description: 'How replies are worded.' }],
        inputs: [],
      }
    },
    playbook: (ask: Ask) => {
      const said = JSON.parse(ask.user) as { task: string; tools: Shown[]; pack: { title: string } }
      const reader = said.tools.find((tool) => !tool.changesThings) ?? said.tools[0]
      const name = (said.task.toLowerCase().match(/[a-z0-9]+/g) ?? ['task']).slice(0, 4).join('-')
      return {
        name,
        markdown: [
          '---',
          `title: ${JSON.stringify(sentence(said.task))}`,
          `description: ${JSON.stringify(`One of the tasks ${said.pack.title} is for.`)}`,
          '---',
          '',
          reader ? `1. Run \`${reader.name}\` with what the task gives.` : '1. Read what the task gives.',
          '2. Say what came back, in plain words.',
          '',
        ].join('\n'),
      }
    },
    skill: (ask: Ask) => {
      const said = JSON.parse(ask.user) as {
        tools: Shown[]
        variables: { name: string }[]
        playbooks: string[]
        pack: { purpose: string }
      }
      return {
        markdown: [
          '## What it is for',
          '',
          said.pack.purpose || 'The tasks it was built for.',
          '',
          '## Which tool for which job',
          '',
          ...said.tools.map(
            (tool) =>
              `- \`${tool.name}\`: ${(tool.description ?? '').split('\n')[0]}${tool.changesThings ? ' It changes things: ask first.' : ''}`,
          ),
          '',
          '## Values already set',
          '',
          said.variables.some((variable) => variable.name === 'tone') ? '- Replies are worded {{tone}}.' : 'None.',
          '',
          '## Playbooks',
          '',
          said.playbooks.length ? said.playbooks.map((name) => `- ${name}`).join('\n') : 'None yet.',
          '',
          '## Gotchas',
          '',
          'None known.',
          '',
          "## What it can't do",
          '',
          'Anything its tools don’t.',
          '',
        ].join('\n'),
      }
    },
    rehearse: (ask: Ask) => {
      const said = JSON.parse(ask.user) as { task: string; tools: Shown[]; steps: unknown[] }
      const reader = said.tools.find((tool) => !tool.changesThings)
      const changer = said.tools.find((tool) => tool.changesThings)
      if (said.steps.length === 0 && reader) return { tool: reader.name, arguments: argumentsFor(reader, said.task) }
      if (said.steps.length === 1 && changer) return { tool: changer.name, arguments: argumentsFor(changer, said.task) }
      return {
        done: true,
        outcome: reader
          ? `${reader.name} answered${changer ? `; ${changer.name} would finish it` : ''}.`
          : 'Nothing here reads, so nothing was tried.',
      }
    },
  })
