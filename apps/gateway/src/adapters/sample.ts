/**
 * The sample tools: three harmless tools built into the gateway, so a new owner can go through every step of the
 * setup (connect, try, give an agent a key, see its call) before connecting a server of their own. Nothing leaves
 * the machine; removing the connection removes them.
 */
import { EMPTY_LISTING } from '../features/catalog/content.js'
import { ProblemError } from '../kit/index.js'
import type { Adapter, RemoteTool } from './index.js'

export const SAMPLE_URL = 'builtin:sample'

const read = { readOnlyHint: true, idempotentHint: true, openWorldHint: false }

const TOOLS: (RemoteTool & { run: (args: Record<string, unknown>) => unknown })[] = [
  {
    name: 'echo',
    title: 'Say it back',
    description: 'Says the text back exactly. The quickest way to check that an agent reaches the gateway.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'What to say back.', maxLength: 2000 } },
      required: ['text'],
    },
    outputSchema: null,
    annotations: read,
    run: (args) => ({ text: String(args.text ?? '') }),
  },
  {
    name: 'current_time',
    title: 'The time now',
    description: 'The date and time now, in a time zone you name (an IANA name like America/New_York), or in UTC.',
    inputSchema: {
      type: 'object',
      properties: {
        timeZone: { type: 'string', description: 'An IANA time zone, e.g. America/New_York. Default UTC.' },
      },
    },
    outputSchema: null,
    annotations: read,
    run: (args) => {
      const timeZone = typeof args.timeZone === 'string' && args.timeZone ? args.timeZone : 'UTC'
      const now = new Date()
      try {
        return {
          timeZone,
          iso: now.toISOString(),
          local: now.toLocaleString('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'long' }),
        }
      } catch {
        throw new ProblemError('bad_request', { detail: `${timeZone} isn’t a time zone. Try America/New_York or UTC.` })
      }
    },
  },
  {
    name: 'roll_dice',
    title: 'Roll dice',
    description: 'Rolls dice and gives each roll and the total. Handy for trying a tool that takes numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 20, default: 1, description: 'How many dice.' },
        sides: { type: 'integer', minimum: 2, maximum: 100, default: 6, description: 'Sides on each die.' },
      },
    },
    outputSchema: null,
    annotations: read,
    run: (args) => {
      const count = Number(args.count ?? 1)
      const sides = Number(args.sides ?? 6)
      const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides))
      return { rolls, total: rolls.reduce((sum, roll) => sum + roll, 0) }
    },
  },
]

export const sampleAdapter = (): Adapter => ({
  list: async () => ({
    tools: TOOLS.map(({ run: _, ...tool }) => tool),
    instructions:
      'Three harmless tools built into the gateway for trying it out: echo, current_time and roll_dice. Remove this connection once you have your own.',
    server: 'sample',
    catalog: EMPTY_LISTING,
  }),
  call: async (_endpoint, _credential, name, args) => {
    const tool = TOOLS.find((entry) => entry.name === name)
    if (!tool) throw new ProblemError('not_found', { detail: `The sample tools have no ${name}.` })
    const result = tool.run(args)
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
  },
  getPrompt: async () => {
    throw new ProblemError('not_found', { detail: 'The sample tools have no playbooks.' })
  },
  readResource: async () => {
    throw new ProblemError('not_found', { detail: 'The sample tools have no links.' })
  },
  watch: async () => null,
  forget: async () => {},
})
