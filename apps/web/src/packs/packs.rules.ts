/**
 * Pure rules for packs: names from titles, what a pack holds in words, why a tool is in, how long a key lasts, the
 * steps of setting one up, what a try of it says, who fills each input of its tools, its variables, where a
 * refused save went wrong, and what a flag says in Reviews.
 */
import type { Schemas } from '@/api/client'
import { argumentsOf, type FormField } from '@/tools/schema-form.rules'

type Pack = Schemas['Pack']
type PackTool = Schemas['PackTool']
type ToolCard = Schemas['ToolCard']
type Use = Schemas['PlaybookUse']
type PackFlag = Schemas['PackFlag']

/**
 * What Reviews says under a flag: what the tool's server says now, what is wrong with a value, or for a playbook or
 * the skill, which tools it was written for that have since moved.
 */
export const flagLine = (flag: Pick<PackFlag, 'kind' | 'was' | 'now'>) =>
  flag.kind === 'input'
    ? `${flag.now}. Open the pack to change the value.`
    : flag.kind === 'wording'
      ? `Its server now says: ${flag.now}`
      : `It was ${flag.was}, which changed or left the pack since. Read it again and save it.`

/** `Design reviews` → `design-reviews`: the name keys and URLs use. */
export const slugOf = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')

/** The one name of the right shape no pack can have: `/api/packs/flags` is a route. */
const RESERVED = 'flags'
export const isPackName = (name: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(name) && name !== RESERVED

/** Why a typed name can't be a pack's; null for one that can, and while nothing is typed. */
export const nameProblem = (name: string) =>
  !name || isPackName(name)
    ? null
    : name === RESERVED
      ? `${RESERVED} is taken: pick another name.`
      : 'Lowercase letters, digits and dashes, starting with a letter or digit.'

/** What renaming a pack means for those set up with its address: its working keys go on at the old one. */
export const renameNote = (keys: number, from: string) =>
  keys
    ? `Its ${keys} ${keys === 1 ? 'person keeps' : 'people keep'} working at /p/${from}; new setup says the new address.`
    : `Nobody has a working key to it, so nobody connects at /p/${from} now.`

/** "12 tools · 3 playbooks · 1 manual", leaving out what it has none of. */
export const holdsLine = ({ tools, playbooks, manuals }: { tools: number; playbooks: number; manuals: number }) => {
  const parts = [
    [tools, 'tool'],
    [playbooks, 'playbook'],
    [manuals, 'manual'],
  ]
    .filter(([count]) => Number(count) > 0)
    .map(([count, word]) => `${count} ${word}${count === 1 ? '' : 's'}`)
  return parts.length ? parts.join(' · ') : 'Nothing in it yet'
}

/** Why a tool is in the pack, in words: who put it there. */
export const reasonOf = (tool: Pick<PackTool, 'reason' | 'via'>, titleOf: (playbook: string) => string) => {
  const from = tool.via ? titleOf(tool.via) : 'a playbook'
  switch (tool.reason) {
    case 'named':
      return `Named in ${from}`
    case 'route':
      return `Called by ${from}`
    case 'meaning':
      return `Suggested for ${from}`
    default:
      return 'Picked'
  }
}

/** What the pack's keys read for a tool, and whether that is the pack's own wording. */
export const wordingOf = (tool: Pick<PackTool, 'wording' | 'upstreamDescription'>) =>
  tool.wording
    ? { text: tool.wording, own: true }
    : { text: tool.upstreamDescription ?? 'This tool is not live: the pack keeps its place.', own: false }

/** The tools a playbook's uses check by default: the certain ones not already in. */
export const preselected = (uses: Use[]) =>
  uses.filter((use) => use.reason !== 'meaning' && !use.inPack).map((use) => use.tool)

export const USE_LABEL: Record<Use['reason'], string> = {
  named: 'Named in the text',
  route: 'Its route is called',
  meaning: 'Likely, by meaning',
}

export const LIFETIMES = [
  { value: '8h', label: '8 hours', hint: 'One working session' },
  { value: '1d', label: 'A day', hint: 'Until this time tomorrow' },
  { value: '7d', label: 'A week', hint: 'For a short project' },
  { value: 'never', label: 'Until revoked', hint: 'For an agent you keep' },
] as const

export type Lifetime = (typeof LIFETIMES)[number]['value']

/** "Expires in 7 h", "Expired", or "Never expires". */
export const expiryOf = (expiresAt: string | null, now = Date.now()) => {
  if (!expiresAt) return { text: 'Never expires', expired: false }
  const left = Date.parse(expiresAt) - now
  if (left <= 0) return { text: 'Expired', expired: true }
  const minutes = Math.round(left / 60_000)
  if (minutes < 60) return { text: `Expires in ${minutes} min`, expired: false }
  const hours = Math.round(minutes / 60)
  if (hours < 48) return { text: `Expires in ${hours} h`, expired: false }
  return { text: `Expires in ${Math.round(hours / 24)} days`, expired: false }
}

/** Tools by connection, in the order they came, each group with its tools. */
export const byConnection = <Tool extends Pick<ToolCard, 'upstream'>>(tools: Tool[]) => {
  const groups = new Map<string, Tool[]>()
  for (const tool of tools) groups.set(tool.upstream, [...(groups.get(tool.upstream) ?? []), tool])
  return [...groups].map(([upstream, list]) => ({ upstream, tools: list }))
}

/** The best few tools for what a pack is for, leaving out what it has and what is switched off. */
export const suggestionsFor = (ranked: ToolCard[], have: Set<string>, limit = 5) =>
  ranked.filter((tool) => !have.has(tool.name) && tool.access !== 'off').slice(0, limit)

/** What a pack is for, as a search: its title and description, cut to what search reads. */
export const packQueryOf = (pack: { title: string; description: string }) =>
  `${pack.title}. ${pack.description}`.trim().slice(0, 200)

/** "Add 3 tools", or what to do first. */
export const addLabel = (count: number) =>
  count ? `Add ${count} tool${count === 1 ? '' : 's'}` : 'Choose tools to add'

/** A tool's one line: its title when it adds something, then its summary. */
export const lineOf = (tool: Pick<ToolCard, 'name' | 'title' | 'summary'>) => {
  const title = tool.title?.trim()
  if (!title || title === tool.name || tool.summary.toLowerCase().startsWith(title.toLowerCase())) return tool.summary
  return `${title}: ${tool.summary}`
}

/** A pack's own name for a tool, from words: `Fetch emails` or `GMAIL_FETCH_EMAILS` → `fetch_emails`-style snake case. */
export const aliasOf = (words: string) =>
  words
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 64)
    .replace(/_+$/, '')

/** An alias the gateway takes: lowercase words joined by `_` or `-`, starting with a letter, no dot. */
export const isAlias = (name: string) => /^[a-z][a-z0-9_-]{1,63}$/.test(name)

/** "from = the desk · account = work", or empty when the pack fixes nothing. */
export const fixedLine = (fixed: Record<string, unknown>) =>
  Object.entries(fixed)
    .map(([key, value]) => `${key} = ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' · ')

export type InputMode = Schemas['PackToolInput']['mode']

/** The three ways an input of a pack tool is filled, as the editor words them. */
export const INPUT_MODES: { id: InputMode; label: string; hint: string }[] = [
  { id: 'fixed', label: 'Fixed', hint: 'Filled on every call and hidden from the pack’s keys.' },
  { id: 'default', label: 'Default', hint: 'Shown with this value; the agent may send another.' },
  { id: 'agent', label: 'Agent decides', hint: 'The agent fills it.' },
]

type Sets = Pick<PackTool, 'fixed' | 'defaults'>

/** Who fills an input, from what the pack stores: an input in neither map is the agent's. */
export const modeOf = (tool: Sets, input: string): InputMode =>
  Object.hasOwn(tool.fixed, input) ? 'fixed' : Object.hasOwn(tool.defaults, input) ? 'default' : 'agent'

/** "Fixed account = {{account}} · Default posted_since = 7", or empty when the pack sets nothing. */
export const inputsLine = (tool: Sets) =>
  (
    [
      ['Fixed', tool.fixed],
      ['Default', tool.defaults],
    ] as const
  )
    .filter(([, values]) => Object.keys(values).length)
    .map(([label, values]) => `${label} ${fixedLine(values)}`)
    .join(' · ')

/** Does the pack set this tool's account, fixed or as a default? */
export const setsAccount = (tool: Sets) =>
  typeof tool.fixed.account === 'string' || typeof tool.defaults.account === 'string'

/** What a pack tool sets, with its account by the label its connection lists it under; one it doesn't list stays. */
export const withAccountLabels = (tool: Sets, labelOf: (account: string) => string | undefined): Sets => {
  const labelled = (values: Record<string, unknown>) =>
    typeof values.account === 'string' ? { ...values, account: labelOf(values.account) ?? values.account } : values
  return { fixed: labelled(tool.fixed), defaults: labelled(tool.defaults) }
}

/** `{{name}}` as the gateway reads it (`features/packs/values.ts`): anything else between braces is plain text. */
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g
const WHOLE = /^\s*\{\{\s*[a-z][a-z0-9_]*\s*\}\}\s*$/

const namesIn = (text: string) => [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ''))]

/** Does a value write a `{{name}}`? */
export const writesVariable = (text: string) => namesIn(text).length > 0

/** A value as it is sent, the pack's variables filled in; `undeclared` are the words no variable has, left as written. */
export const filledIn = (text: string, variables: { name: string; value: string | number | boolean }[]) => {
  const values = new Map(variables.map((variable) => [variable.name, String(variable.value)]))
  return {
    text: text.replace(PLACEHOLDER, (whole, name: string) => values.get(name) ?? whole),
    undeclared: namesIn(text).filter((name) => !values.has(name)),
  }
}

/** A field whose control is not free text: a variable there replaces the value, and is sent as written. */
const isTyped = (field: FormField) => field.kind !== 'text' && field.kind !== 'long-text'

/**
 * The editor's form as what the pack fixes and defaults. A value that writes a variable goes as written whatever
 * the input takes (the gateway fills it in, then checks it), a switch that is off is `false`, and a fixed or default
 * input needs a value.
 */
export const inputValuesOf = (fields: FormField[], modes: Record<string, InputMode>, texts: Record<string, string>) => {
  const fixed: Record<string, unknown> = {}
  const defaults: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const mode = modes[field.name] ?? 'agent'
    if (mode === 'agent') continue
    const into = mode === 'fixed' ? fixed : defaults
    const raw = texts[field.name] ?? ''
    if (field.kind === 'json' ? WHOLE.test(raw) : isTyped(field) && writesVariable(raw)) into[field.name] = raw.trim()
    else if (field.kind === 'boolean') into[field.name] = raw === 'true'
    else if (raw.trim() === '') errors[field.name] = 'Give it a value, or let the agent decide.'
    else {
      const read = argumentsOf([field], { [field.name]: raw })
      const error = read.errors[field.name]
      if (error) errors[field.name] = error
      else into[field.name] = read.args[field.name]
    }
  }
  return { fixed, defaults, errors }
}

/** A value with a picked variable written in: over a typed value, at the end of text. */
export const withVariable = (field: FormField, text: string, name: string) =>
  isTyped(field) ? `{{${name}}}` : `${text}{{${name}}}`

/** What no longer fits a pack tool: the inputs its upstream dropped, then each value it now refuses. */
export const problemLines = (tool: Pick<PackTool, 'tool' | 'lostInputs' | 'inputs'>) => [
  ...(tool.lostInputs.length ? [`${tool.tool} no longer takes ${tool.lostInputs.join(', ')}`] : []),
  ...tool.inputs.flatMap((input) => (input.problem ? [input.problem] : [])),
]

/**
 * What a tool's flagged values do to calls until the owner changes them, the worst of what stands: a fixed value the
 * tool refuses fails every call, a default it refuses only the calls that leave the input out, and a value for an
 * input the tool dropped is still sent.
 */
export const failsLine = (tool: Pick<PackTool, 'lostInputs' | 'inputs'>) => {
  const refused = tool.inputs.filter((input) => input.problem)
  if (refused.some((input) => input.mode === 'fixed')) return 'every call fails until you change what the pack sets'
  if (refused.length) return 'calls that don’t send their own value fail until you change what the pack sets'
  return `the pack still sends ${tool.lostInputs.length === 1 ? 'it' : 'them'}, so calls fail only if the server refuses an input it doesn’t know. Change what the pack sets`
}

/** "limit was not checked: …" for the values the gateway could not check against the tool's schema, or null. */
export const uncheckedLine = (tool: Pick<PackTool, 'inputs'>) => {
  const names = tool.inputs.filter((input) => input.unchecked).map((input) => input.name)
  const one = names.length === 1
  return names.length
    ? `${names.join(', ')} ${one ? 'was' : 'were'} not checked: the gateway can’t read ${one ? 'its' : 'their'} schema, so only a call checks ${one ? 'it' : 'them'}.`
    : null
}

/** A variable's name as the gateway takes it. */
const VARIABLE = /^[a-z][a-z0-9_]{0,39}$/

/** What is wrong with a new variable's name, or null. */
export const variableProblem = (name: string, taken: Set<string>) =>
  name === ''
    ? 'Give it a name, like desk_name.'
    : !VARIABLE.test(name)
      ? 'Start with a lowercase letter, then lowercase letters, digits or _ (40 at most), like desk_name.'
      : taken.has(name)
        ? `${name} is already a variable of this pack: change that one, or pick another name.`
        : null

export type VariableKind = 'text' | 'number' | 'boolean'
export const VARIABLE_KINDS: { id: VariableKind; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'number', label: 'Number' },
  { id: 'boolean', label: 'Yes or no' },
]

export const kindOfValue = (value: string | number | boolean): VariableKind =>
  typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text'

/** A variable's value as the kind the owner picked: `7` the number is not `7` the text to an input's schema. */
export const variableValueOf = (
  kind: VariableKind,
  text: string,
): { value: string | number | boolean; error: null } | { value: null; error: string } => {
  if (kind === 'boolean') return { value: text === 'true', error: null }
  if (kind === 'text') return text === '' ? { value: null, error: 'Give it a value.' } : { value: text, error: null }
  const number = Number(text)
  return text.trim() === '' || Number.isNaN(number)
    ? { value: null, error: 'A number, like 7.' }
    : { value: number, error: null }
}

/** "Used by items.get_item, work_inbox", or that nothing writes it yet. */
export const usedLine = (usedBy: string[]) => (usedBy.length ? `Used by ${usedBy.join(', ')}` : 'Not used yet')

/** Where a refused save went wrong: a tool's input (`tools.<name>.fixed.<input>`), or a variable. */
export const placeOf = (path: string): { tool: string; input: string } | { variable: string } | null => {
  const input = /^tools\.(.+)\.(?:fixed|defaults)\.([^.]+)$/.exec(path)
  if (input?.[1] && input[2]) return { tool: input[1], input: input[2] }
  const variable = /^variables\.(.+)$/.exec(path)
  return variable?.[1] ? { variable: variable[1] } : null
}

type Refused = { message: string; errors: { path: string; message: string }[] }

const stop = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`)

/**
 * A refused save of one pack tool: each problem beside its input, and the rest to say under the form. `tools` are
 * the names the tool may be refused under (its stored name, and the one being saved).
 */
export const refusedInputs = (refused: Refused, tools: string[], inputs: string[]) => {
  const byInput: Record<string, string> = {}
  const rest: string[] = refused.errors.length ? [] : [refused.message]
  for (const error of refused.errors) {
    const place = placeOf(error.path)
    const here = place && 'tool' in place && tools.includes(place.tool)
    if (here && inputs.includes(place.input)) byInput[place.input] ??= stop(error.message)
    else rest.push(place && 'tool' in place && !here ? `${place.tool}: ${stop(error.message)}` : stop(error.message))
  }
  return { byInput, rest }
}

/**
 * A refused save of a pack's variables: each problem beside its variable. A value that stops fitting a tool's input
 * goes beside every variable that value writes; what belongs to none is the rest.
 */
export const refusedVariables = (refused: Refused, tools: (Sets & Pick<PackTool, 'name'>)[]) => {
  const byVariable: Record<string, string[]> = {}
  const rest: string[] = refused.errors.length ? [] : [refused.message]
  const beside = (name: string, message: string) => {
    byVariable[name] = [...(byVariable[name] ?? []), message]
  }
  for (const error of refused.errors) {
    const place = placeOf(error.path)
    if (!place) rest.push(stop(error.message))
    else if ('variable' in place) beside(place.variable, stop(error.message))
    else {
      const tool = tools.find((candidate) => candidate.name === place.tool)
      const written = namesIn(JSON.stringify(tool?.fixed[place.input] ?? tool?.defaults[place.input] ?? ''))
      const message = `${place.tool}: ${stop(error.message)}`
      if (written.length) for (const name of written) beside(name, message)
      else rest.push(message)
    }
  }
  return { byVariable, rest }
}

/** The app a Composio tool belongs to: the toolkit its name starts with (`composio.gmail_fetch_emails` → gmail). */
export const toolkitOf = (name: string, toolkits: string[]) => {
  const rest = name.slice(name.indexOf('.') + 1)
  return toolkits.find((toolkit) => rest.startsWith(`${toolkit}_`)) ?? rest.split('_')[0] ?? rest
}

export type Effect = 'reads' | 'changes' | 'deletes'
export const EFFECTS: { id: Effect; label: string }[] = [
  { id: 'reads', label: 'Reads' },
  { id: 'changes', label: 'Changes things' },
  { id: 'deletes', label: 'Deletes' },
]

/** What a tool does: reads, changes things, or deletes (overwrites) them. */
export const effectOf = (tool: Pick<ToolCard, 'needsWrite' | 'destructive'>): Effect =>
  tool.destructive ? 'deletes' : tool.needsWrite ? 'changes' : 'reads'

/** A pack name for a tool on one account: `Acme Work Email` + `Fetch emails` → `acme_fetch_emails`. */
export const accountAlias = (label: string, title: string) => aliasOf(`${label.split(/[\s\-–·,]+/)[0] ?? ''} ${title}`)

/** The alias, or the alias with `_2`, `_3`… when the pack already has it. */
export const freeAlias = (alias: string, taken: Set<string>) => {
  if (!taken.has(alias)) return alias
  let n = 2
  while (taken.has(`${alias}_${n}`)) n++
  return `${alias}_${n}`
}

const countOf = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** The four steps of setting a pack up, in order. A pack whose keys already call counts as tried. */
export const checklistOf = (pack: Pick<Pack, 'description' | 'counts' | 'triedAt' | 'lastCallAt'>) => {
  const steps = [
    { id: 'describe', label: 'Describe it', done: Boolean(pack.description.trim()) },
    { id: 'tools', label: 'Add tools', done: pack.counts.tools > 0 },
    { id: 'try', label: 'Try it as the pack', done: Boolean(pack.triedAt || pack.lastCallAt) },
    { id: 'connect', label: 'Connect an app', done: Boolean(pack.lastCallAt) },
  ] as const
  const done = steps.filter((step) => step.done).length
  return { steps, done, total: steps.length, complete: done === steps.length }
}

export type ChecklistStep = ReturnType<typeof checklistOf>['steps'][number]

/**
 * "2 tools stood out · 18 others didn't match": `shown` of the `listed` tools the same viewer gets without a query.
 * Only "2 tools found" when none is known to have been left out (every listed tool came back, or `listed` isn't
 * known: still loading, or cut by its limit): a small gateway answers with the nearest tools, standing out or not.
 */
export const stoodOutLine = (shown: number, listed: number | null | undefined) => {
  const rest = (listed ?? 0) - shown
  return rest > 0
    ? `${countOf(shown, 'tool')} stood out · ${countOf(rest, 'other')} didn't match`
    : `${countOf(shown, 'tool')} found`
}

/** A search of a pack that found nothing, where the API sent no hint. */
export const emptyLine = (title: string, query: string) => `Nothing in ${title} matches “${query}”.`

/** What a pack covers, from the API's hint, in the words its keys are told. */
export const coversLine = ({ covers, more }: Pick<NonNullable<Schemas['ToolList']['hint']>, 'covers' | 'more'>) =>
  covers.length
    ? `This pack covers: ${covers.join(', ')}${more ? `, and ${more} more` : ''}.`
    : 'This pack holds no tools this key can use.'

/** Matches a read-only key isn't shown because they change things. */
export const hiddenLine = (count: number) =>
  `${countOf(count, 'matching tool')} ${count === 1 ? 'changes things and is' : 'change things and are'} hidden from this read-only key.`

/** An address as people read it, without its scheme: `https://gw.example.com/p/loud` → `gw.example.com/p/loud`. */
export const shortAddress = (url: string) => url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
