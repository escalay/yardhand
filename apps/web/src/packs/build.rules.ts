/**
 * Pure rules for Build and Refresh with AI: the estimate and the cost in words, the tasks, why a start was refused,
 * and the proposal: its groups, what each line is called and reads as, what ticking or unticking one does, where a
 * refused accept's findings belong, and the rehearsal in a line a task.
 */
import type { Schemas } from '@/api/client'

type Line = Schemas['PackBuildLine']
type Build = Schemas['PackBuild']
type Rehearsal = NonNullable<Build['proposal']>['rehearsal'][number]
type Step = Rehearsal['steps'][number]

export const MAX_TASKS = 5
const TASK_MIN = 3
const TASK_MAX = 300

const dollars = (usd: number) => `$${usd.toFixed(2)}`
/** "$0.31", or "Under $0.01" for less than a cent. */
const amountOf = (usd: number) => (usd < 0.005 ? 'Under $0.01' : dollars(usd))

/** "About $0.31 of $1.00", or that no price is known. */
export const estimateLine = ({ usd, capUsd }: Pick<Schemas['PackBuildEstimate'], 'usd' | 'capUsd' | 'priceKnown'>) =>
  usd === null
    ? 'Cost not known for this provider: held to a token budget'
    : usd < 0.005
      ? `Under $0.01 of ${dollars(capUsd)}`
      : `About ${dollars(usd)} of ${dollars(capUsd)}`

/** The gateway refuses a start estimated over the cap: the dialog holds it back first. */
export const overCap = ({ usd, capUsd }: { usd: number | null; capUsd: number }) => usd !== null && usd > capUsd

export const realCallsLine = (calls: number) =>
  `up to ${calls} real read call${calls === 1 ? '' : 's'} on your accounts`

/** What is wrong with the example tasks as typed (blank ones are left out), or null. */
export const tasksProblem = (tasks: string[]) => {
  const given = tasks.map((task) => task.trim())
  if (!given.some(Boolean)) return 'Give at least one example task.'
  for (const [index, task] of given.entries()) {
    if (task && task.length < TASK_MIN) return `Task ${index + 1} is too short: say it in a few words.`
    if (task.length > TASK_MAX) return `Task ${index + 1} is too long: ${TASK_MAX} characters at most.`
  }
  return null
}

/** Why a start or an estimate was refused, and whether Settings › AI is where to fix it. */
export const startProblem = (
  error: { status: number; message: string; code?: string; retryAfter?: number },
  title: string,
) => {
  if (error.status === 429 && error.code !== 'spend_cap')
    return {
      text: `${title} has had six builds this hour, counting refused ones: try again ${
        error.retryAfter ? `in ${Math.max(1, Math.ceil(error.retryAfter / 60))} minutes` : 'within the hour'
      }.`,
      settings: false,
    }
  return { text: error.message, settings: error.status === 409 && error.message.includes('no model to ask') }
}

/** What the pack page says while a build runs or waits to be accepted. */
export const buildNote = (build: Schemas['Pack']['build']) =>
  !build ? null : build.status === 'running' ? 'A build is running' : 'A proposal is ready'

const GROUPS = [
  { id: 'tools', title: 'Tools', kinds: ['tool', 'input', 'wording'] },
  { id: 'variables', title: 'Variables', kinds: ['variable'] },
  { id: 'playbooks', title: 'Playbooks', kinds: ['playbook'] },
  { id: 'skill', title: 'Skill', kinds: ['skill'] },
] as const

/** The proposal's groups in the screen's order, empty ones left out; a tool's lines first, then inputs, then wording. */
export const groupsOf = (lines: Line[]) =>
  GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    lines: group.kinds.flatMap((kind) => lines.filter((line) => line.kind === kind)),
  })).filter((group) => group.lines.length)

/** `<tool>.<input>` split at its last dot: tool names hold dots, input names don't. */
const inputParts = (target: string) => {
  const at = target.lastIndexOf('.')
  return { tool: target.slice(0, at), input: target.slice(at + 1) }
}

export const labelOf = (line: Line) => {
  if (line.kind === 'input') {
    const { tool, input } = inputParts(line.target)
    return `Input ${input} of ${tool}`
  }
  return line.kind === 'tool'
    ? `Tool ${line.target}`
    : line.kind === 'wording'
      ? `Wording of ${line.target}`
      : line.kind === 'variable'
        ? `Variable ${line.target}`
        : line.kind === 'playbook'
          ? `Playbook ${line.target}`
          : 'The skill'
}

/** The lines ticked to begin with: the build's own suggestion, which never holds a tool that changes things. */
export const preselected = (lines: Line[]) => lines.filter((line) => line.suggested).map((line) => line.id)

/** The chosen lines and everything they need, all the way down. */
export const withNeeds = (chosen: string[], lines: Line[]) => {
  const byId = new Map(lines.map((line) => [line.id, line]))
  const all = new Set<string>()
  const add = (id: string) => {
    if (all.has(id)) return
    all.add(id)
    for (const need of byId.get(id)?.needs ?? []) add(need)
  }
  for (const id of chosen) add(id)
  return all
}

/** The ticked lines that need this one: unticking it would leave them unable to be accepted. */
export const orphansOf = (id: string, chosen: string[], lines: Line[]) =>
  lines.filter((line) => line.id !== id && chosen.includes(line.id) && line.needs.includes(id))

/** A line ticked brings what it needs; unticking one a ticked line needs is held, naming who holds it. */
export const toggled = (id: string, chosen: string[], lines: Line[]) => {
  if (!chosen.includes(id)) return { chosen: [...withNeeds([...chosen, id], lines)], heldFor: [] as string[] }
  const holders = orphansOf(id, chosen, lines)
  return holders.length
    ? { chosen, heldFor: holders.map(labelOf) }
    : { chosen: chosen.filter((entry) => entry !== id), heldFor: [] as string[] }
}

const valueText = (value: unknown) => JSON.stringify(value) ?? String(value)
const MODES = { fixed: 'Fixed', default: 'Default', agent: 'Agent decides' } as const

/** One side of a line as text; null where there is nothing (an add's before, a removal's after). */
const sideOf = (kind: Line['kind'], value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (kind === 'tool') return `runs ${(value as { tool: string }).tool}`
  if (kind === 'input') {
    const { mode, value: set } = value as { mode: keyof typeof MODES; value: unknown }
    return mode === 'agent' ? MODES.agent : `${MODES[mode]}: ${valueText(set)}`
  }
  if (kind === 'variable') {
    const { value: set, description } = value as { value: unknown; description: string | null }
    return description ? `${valueText(set)} · ${description}` : valueText(set)
  }
  return typeof value === 'string' ? value : valueText(value)
}

/** A line's before and after as the screen shows them; playbooks and the skill are Markdown. */
export const sidesOf = (line: Line) => ({
  before: sideOf(line.kind, line.before),
  after: sideOf(line.kind, line.after),
  markdown: line.kind === 'playbook' || line.kind === 'skill',
})

/** The line a finding's path belongs to (`tools.<name>.fixed.<input>`, `variables.<name>`, …), or null. */
const lineOfPath = (path: string) => {
  const input = /^tools\.(.+)\.(fixed|defaults)\.([^.]+)$/.exec(path)
  if (input) return `input:${input[1]}.${input[3]}`
  if (path === 'skill') return 'skill'
  if (path.startsWith('variables.')) return `variable:${path.slice(10)}`
  if (path.startsWith('playbooks.')) return `playbook:${path.slice(10)}`
  if (path.startsWith('tools.')) return `tool:${path.slice(6)}`
  return null
}

/** A refused accept's findings beside their lines; what belongs to no line is said above them. */
export const findingsByLine = (errors: { path: string; message: string }[]) => {
  const byLine = new Map<string, string[]>()
  const elsewhere: string[] = []
  for (const error of errors) {
    const id = lineOfPath(error.path)
    if (id) byLine.set(id, [...(byLine.get(id) ?? []), error.message])
    else elsewhere.push(error.message)
  }
  return { byLine, elsewhere }
}

const shortName = (tool: string) => tool.slice(tool.lastIndexOf('.') + 1)
const plainOutcome = (outcome: string) => {
  const trimmed = outcome.trim().replace(/\.$/, '')
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1)
}

/** "send skipped: it changes things, so it was not tried", from what the model was handed instead. */
export const skippedLine = (step: Step) => {
  const said = (step.standIn ?? '').replace(/^\[|\]$/g, '')
  const why = said.includes('changes things')
    ? 'it changes things, so it was not tried'
    : said.includes('switched off')
      ? 'you switched it off, so it was not tried'
      : said.includes('not live')
        ? 'it is not live, so it was not tried'
        : said.startsWith('Not in ')
          ? 'it is not in the pack, so it was not tried'
          : said
  return `${shortName(step.tool)} skipped: ${why}`
}

/** "Reply: draft written, send skipped": what came of a task, and what wasn't really run. */
export const rehearsalLine = (rehearsal: Pick<Rehearsal, 'task' | 'outcome' | 'steps'>) =>
  [
    `${rehearsal.task}: ${plainOutcome(rehearsal.outcome)}`,
    ...rehearsal.steps.filter((step) => !step.ran).map((step) => `${shortName(step.tool)} skipped`),
  ].join(', ')

/** "$0.31 of $1.00", or the tokens when no price is known. */
export const costLine = (spent: Build['spent'], capUsd: number) =>
  spent.known
    ? `${amountOf(spent.usd)} of ${dollars(capUsd)}`
    : `${spent.tokens.toLocaleString('en-US')} tokens: cost not known for this provider`

/** Where a stopped build stopped and what it didn't do; null for one that wasn't stopped. */
export const stoppedLine = ({ stopped, notDone }: Pick<Build, 'stopped' | 'notDone'>, capUsd: number) => {
  if (!stopped) return null
  const where =
    stopped === 'cap'
      ? `Stopped at ${dollars(capUsd)}.`
      : 'Stopped: the provider refused to spend more (no credit left, or a limit on the key).'
  return [where, notDone.length ? `Not done: ${notDone.join(', ')}.` : null, 'What is here can still be accepted.']
    .filter(Boolean)
    .join(' ')
}

/** The most a build may spend on the model: the gateway's `BUILD_CAP_USD`, which a build's answer doesn't carry. */
export const BUILD_CAP_USD = 1
