/**
 * Pure rules for packs: names from titles, what a pack holds in words, why a tool is in, how long a key lasts, the
 * steps of setting one up, what a try of it says, who fills each input of its tools, its variables, where a refused
 * save went wrong, what it has to recheck, what a flag says in Reviews, what sharing it asks and what its People list
 * says of each person.
 */
import type { Schemas } from '@/api/client'
import { argumentsOf, type FormField } from '@/tools/schema-form.rules'

type Pack = Schemas['Pack']
type Person = Schemas['Person']
type PackTool = Schemas['PackTool']
type ToolCard = Schemas['ToolCard']
type Use = Schemas['PlaybookUse']
type PackFlag = Schemas['PackFlag']
type Variable = Schemas['PackVariable']

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

const countOf = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

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

/**
 * "12 tools · 3 playbooks · 1 manual", leaving out what it has none of. The playbooks written for the pack count
 * with the ones it holds from its connections.
 */
export const holdsLine = ({
  tools,
  playbooks,
  manuals,
  ownPlaybooks = 0,
}: {
  tools: number
  playbooks: number
  manuals: number
  ownPlaybooks?: number
}) => {
  const parts = [
    [tools, 'tool'],
    [playbooks + ownPlaybooks, 'playbook'],
    [manuals, 'manual'],
  ]
    .filter(([count]) => Number(count) > 0)
    .map(([count, word]) => `${count} ${word}${count === 1 ? '' : 's'}`)
  return parts.length ? parts.join(' · ') : 'Nothing in it yet'
}

type Flagged = { flag: unknown | null }

/**
 * What a pack has to recheck, by where it is settled: its flagged playbooks and skill, and its tools, which are the
 * rest of `flags` (the gateway counts the pack's own texts in it too).
 */
export const recheckOf = (pack: { flags: number; ownPlaybooks: Flagged[]; skill: Flagged | null }) => {
  const playbooks = pack.ownPlaybooks.filter((playbook) => playbook.flag).length
  const skill = Boolean(pack.skill?.flag)
  return { tools: Math.max(0, pack.flags - playbooks - (skill ? 1 : 0)), playbooks, skill }
}

/** "2 tools, 1 playbook and the skill to recheck", "The skill to recheck", or null when nothing is flagged. */
export const recheckLine = ({ tools, playbooks, skill }: ReturnType<typeof recheckOf>) => {
  const parts = [
    ...(tools ? [countOf(tools, 'tool')] : []),
    ...(playbooks ? [countOf(playbooks, 'playbook')] : []),
    ...(skill ? ['the skill'] : []),
  ]
  if (!parts.length) return null
  const listed = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : `${parts[0]}`
  return `${listed.charAt(0).toUpperCase()}${listed.slice(1)} to recheck`
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

/** The four ways an input of a pack tool is filled, as the editor words them. */
export const INPUT_MODES: { id: InputMode; label: string; hint: string }[] = [
  { id: 'fixed', label: 'Fixed', hint: 'Filled on every call and hidden from the pack’s keys.' },
  { id: 'default', label: 'Default', hint: 'Shown with this value; the agent may send another.' },
  { id: 'agent', label: 'Agent decides', hint: 'The agent fills it.' },
  {
    id: 'person',
    label: 'Per person',
    hint: 'Hidden from the agent and filled with each person’s own value, set under People; else the pack’s. Use Fixed for anything that limits what they reach.',
  },
]

type Sets = Pick<PackTool, 'fixed' | 'defaults'> & Partial<Pick<PackTool, 'person'>>

/** Who fills an input, from what the pack stores: an input in none of the maps is the agent's. */
export const modeOf = (tool: Sets, input: string): InputMode =>
  Object.hasOwn(tool.fixed, input)
    ? 'fixed'
    : Object.hasOwn(tool.defaults, input)
      ? 'default'
      : tool.person && Object.hasOwn(tool.person, input)
        ? 'person'
        : 'agent'

/** "Fixed account = {{account}} · Default posted_since = 7 · Per person location = {{city}}", or empty. */
export const inputsLine = (tool: Sets) =>
  (
    [
      ['Fixed', tool.fixed],
      ['Default', tool.defaults],
      ['Per person', tool.person ?? {}],
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
  return {
    fixed: labelled(tool.fixed),
    defaults: labelled(tool.defaults),
    ...(tool.person ? { person: tool.person } : {}),
  }
}

/** `{{name}}` as the gateway reads it (`features/packs/values.ts`): anything else between braces is plain text. */
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g
const WHOLE = /^\s*\{\{\s*[a-z][a-z0-9_]*\s*\}\}\s*$/

const namesIn = (text: string) => [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ''))]

/** Does a value write a `{{name}}`? */
export const writesVariable = (text: string) => namesIn(text).length > 0

/**
 * A value as it is sent, the pack's variables filled in; `undeclared` are the words no variable has, left as written.
 * A variable with no value of the pack's is declared, and left as written.
 */
export const filledIn = (text: string, variables: { name: string; value: string | number | boolean | null }[]) => {
  const values = new Map(
    variables.flatMap((variable) => (variable.value === null ? [] : [[variable.name, String(variable.value)]])),
  )
  const declared = new Set(variables.map((variable) => variable.name))
  return {
    text: text.replace(PLACEHOLDER, (whole, name: string) => values.get(name) ?? whole),
    undeclared: namesIn(text).filter((name) => !declared.has(name)),
  }
}

/** A field whose control is not free text: a variable there replaces the value, and is sent as written. */
const isTyped = (field: FormField) => field.kind !== 'text' && field.kind !== 'long-text'

/**
 * The editor's form as what the pack fixes, defaults and fills per person. A value that writes a variable goes as
 * written whatever the input takes (the gateway fills it in, then checks it), a switch that is off is `false`, a
 * fixed or default input needs a value, and one filled per person one variable and nothing else.
 */
export const inputValuesOf = (fields: FormField[], modes: Record<string, InputMode>, texts: Record<string, string>) => {
  const fixed: Record<string, unknown> = {}
  const defaults: Record<string, unknown> = {}
  const person: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const mode = modes[field.name] ?? 'agent'
    if (mode === 'agent') continue
    const raw = texts[field.name] ?? ''
    if (mode === 'person') {
      if (WHOLE.test(raw)) person[field.name] = raw.trim()
      else errors[field.name] = 'Pick the variable each person fills.'
      continue
    }
    const into = mode === 'fixed' ? fixed : defaults
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
  return { fixed, defaults, person, errors }
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

export const kindOfValue = (value: string | number | boolean | null): VariableKind =>
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

/** A field for one person's value of a variable the pack's Per person inputs read. */
export type PersonalField = {
  name: string
  kind: VariableKind
  hint: string
  fallback: string | number | boolean | null
}

/** The fields the Share sheet and People ask a person's values in: one per variable each person fills. */
export const personalFields = (pack: {
  variables: Pick<Variable, 'name' | 'value' | 'description' | 'perPerson' | 'kind'>[]
}) =>
  pack.variables
    .filter((variable) => variable.perPerson)
    .map(
      (variable): PersonalField => ({
        name: variable.name,
        kind: variable.kind,
        hint: [
          variable.description ? stop(variable.description) : '',
          variable.value === null
            ? 'Left empty, they get nothing, and a call that needs it is refused.'
            : `Left empty, they get the pack’s: ${String(variable.value)}.`,
        ]
          .filter(Boolean)
          .join(' '),
        fallback: variable.value,
      }),
    )

/**
 * What a person's fields say, by variable: each read as the variable's kind (the gateway's, from the inputs that read
 * it), an empty one left out (they get the pack's), and one left as `stored` had it sent as it was. Typed in a text
 * box, yes or no is `true` or `false`.
 */
export const personValuesOf = (
  fields: PersonalField[],
  texts: Record<string, string>,
  stored: Record<string, string | number | boolean> = {},
) => {
  const values: Record<string, string | number | boolean> = {}
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const text = (texts[field.name] ?? '').trim()
    if (text === '') continue
    const kept = stored[field.name]
    if (kept !== undefined && text === String(kept)) {
      values[field.name] = kept
      continue
    }
    const flag = /^(true|false)$/i.exec(text)?.[1]?.toLowerCase()
    const read =
      field.kind !== 'boolean'
        ? variableValueOf(field.kind, text)
        : flag
          ? { value: flag === 'true', error: null }
          : { value: null, error: 'true or false.' }
    if (read.error === null) values[field.name] = read.value
    else errors[field.name] = read.error
  }
  return { values, errors }
}

/** "city: Lisbon · days: 3", or empty when a person has no values of their own. */
export const valuesLine = (values: Record<string, string | number | boolean>) =>
  Object.entries(values)
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join(' · ')

/** "Used by items.get_item, work_inbox", or that nothing writes it yet. */
export const usedLine = (usedBy: string[]) => (usedBy.length ? `Used by ${usedBy.join(', ')}` : 'Not used yet')

/**
 * Where a refused save went wrong: a tool's input (`tools.<name>.fixed.<input>`), or a variable (of the pack, or a
 * person's value of it).
 */
export const placeOf = (path: string): { tool: string; input: string } | { variable: string } | null => {
  const input = /^tools\.(.+)\.(?:fixed|defaults|person)\.([^.]+)$/.exec(path)
  if (input?.[1] && input[2]) return { tool: input[1], input: input[2] }
  const variable = /^(?:variables|values)\.(.+)$/.exec(path)
  return variable?.[1] ? { variable: variable[1] } : null
}

type Refused = { message: string; errors: { path: string; message: string }[] }

/** A sentence with its full stop. */
export const stop = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`)

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
      const written = namesIn(
        JSON.stringify(tool?.fixed[place.input] ?? tool?.defaults[place.input] ?? tool?.person?.[place.input] ?? ''),
      )
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

export type PackTab = 'overview' | 'tools' | 'playbooks' | 'people' | 'activity'
const PACK_TABS: PackTab[] = ['overview', 'tools', 'playbooks', 'people', 'activity']

/**
 * `?tab=` for every part but Tools, the default; `?add=true` there opens the dialog that adds tools, and `?share=true`
 * on any part the Share sheet. People was Keys: a link kept from then still opens it.
 */
export const parsePackTab = (raw: Record<string, unknown>): { tab?: PackTab; add?: true; share?: true } => {
  const asked = raw.tab === 'keys' ? 'people' : (raw.tab as PackTab)
  const part = PACK_TABS.includes(asked) && asked !== 'tools' ? { tab: asked } : {}
  if (raw.share === true) return { ...part, share: true }
  return part.tab || raw.add !== true ? part : { add: true }
}

/** How long a shared pack works for its person. A day or less is a key for an agent of your own: made under Agents. */
export const SHARE_LIFETIMES = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'never', label: 'Until revoked' },
] as const

export type ShareLifetime = (typeof SHARE_LIFETIMES)[number]['value']
export const SHARE_DEFAULT: ShareLifetime = '30d'

/** What Extend sets a person's end to, counted from today. */
export const EXTEND_CHOICES = [
  { value: '7d', label: '7 days from today' },
  { value: '30d', label: '30 days from today' },
  { value: 'never', label: 'Until revoked' },
] as const satisfies { value: ShareLifetime; label: string }[]

const APP_LABEL: Record<NonNullable<Person['app']>, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
  'claude-ai': 'claude.ai',
  curl: 'A script',
  typescript: 'TypeScript',
}

/** Where a person will paste their key: the apps the message has setup for, and not being sure. */
export const SHARE_APPS: { value: string; app: NonNullable<Schemas['PackShare']['app']> | null; label: string }[] = [
  ...(['claude-code', 'cursor', 'codex', 'curl'] as const).map((app) => ({ value: app, app, label: APP_LABEL[app] })),
  { value: 'unsure', app: null, label: 'Not sure' },
]

/** How many of a pack's live tools change things: with none, a key that can change is no different from one that reads. */
export const changingTools = (pack: { tools: Pick<PackTool, 'needsWrite' | 'live'>[] }) =>
  pack.tools.filter((tool) => tool.live && tool.needsWrite).length

/** "3 tools here change things". */
export const changesLine = (count: number) =>
  `${count} ${count === 1 ? 'tool here changes' : 'tools here change'} things`

/** "Claude Code · key": the app a person was given setup for, when it was said, and how they get in. */
export const connectsVia = ({ app, kind }: Pick<Person, 'app' | 'kind'>) =>
  [...(app ? [APP_LABEL[app]] : []), kind === 'oauth' ? 'sign-in' : 'key'].join(' · ')

export const accessOf = (scope: Person['scope']) => (scope === 'write' ? 'can change' : 'read only')

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** As the API's `ending`: the last three days of someone's access. */
const SOON_MS = 3 * DAY_MS
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The UTC day of a time as `21 Dec`: the day the message a person was sent names, wherever it is read. */
export const dayOf = (iso: string) => {
  const at = new Date(iso)
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`
}

/**
 * When someone's access ends: "never", "21 Dec", "in 3 d" within three days, "ended 2 Dec". Days are UTC days, as
 * Home's nudge counts them and as `dayOf` names the day; under a day it is hours, then minutes. `warn` is the API's
 * `ending`, which a key made for a day or less never is: that one ends soon because it was meant to.
 */
export const endsOf = (
  person: Pick<Person, 'expiresAt'> & Partial<Pick<Person, 'ending' | 'ended'>>,
  now = Date.now(),
) => {
  if (!person.expiresAt) return { text: 'never', warn: false }
  const end = Date.parse(person.expiresAt)
  const left = end - now
  if (person.ended || left <= 0) return { text: `ended ${dayOf(person.expiresAt)}`, warn: false }
  if (left > SOON_MS) return { text: dayOf(person.expiresAt), warn: false }
  const warn = Boolean(person.ending)
  if (left >= DAY_MS) return { text: `in ${Math.floor(end / DAY_MS) - Math.floor(now / DAY_MS)} d`, warn }
  if (left >= HOUR_MS) return { text: `in ${Math.round(left / HOUR_MS)} h`, warn }
  return { text: `in ${Math.max(1, Math.round(left / 60_000))} min`, warn }
}

/** The same beside a name, where no column says what it is: "ends 21 Dec", "until revoked", "ended 2 Dec". */
export const endLine = (person: Parameters<typeof endsOf>[0], now = Date.now()) => {
  const { text } = endsOf(person, now)
  return text === 'never' ? 'until revoked' : text.startsWith('ended') ? text : `ends ${text}`
}

/** What Extend and Revoke say of a key that opens other packs too: its end and its revoking are theirs as well. */
export const alsoOpens = (otherPacks: string[]) => {
  if (!otherPacks.length) return ''
  const names =
    otherPacks.length === 1 ? otherPacks[0] : `${otherPacks.slice(0, -1).join(', ')} and ${otherPacks.at(-1)}`
  return `This key also opens ${names}: that changes too.`
}

/** How many of a pack's people last connected at a name it used to have. */
export const stillThere = (people: number) =>
  people
    ? `${people} ${people === 1 ? 'person still connects' : 'people still connect'} there`
    : 'nobody has connected there since the rename'
