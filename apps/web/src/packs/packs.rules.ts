/**
 * Pure rules for packs: names from titles, what a pack holds in words, why a tool is in, how long a key lasts, the
 * steps of setting one up and what a try of it says.
 */
import type { Schemas } from '@/api/client'

type Pack = Schemas['Pack']
type PackTool = Schemas['PackTool']
type ToolCard = Schemas['ToolCard']
type Use = Schemas['PlaybookUse']

/** `Design reviews` → `design-reviews`: the name keys and URLs use. */
export const slugOf = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')

export const isPackName = (name: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(name) && name !== 'flags'

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

/** An address as people read it, without its scheme: `https://gw.example.com/p/career` → `gw.example.com/p/career`. */
export const shortAddress = (url: string) => url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
