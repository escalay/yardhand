/**
 * Pure rules for packs: names from titles, what a pack holds in words, why a tool is in, how long a key lasts, the
 * steps of setting one up, what a try of it says, what sharing it asks and what its People list says of each person.
 */
import type { Schemas } from '@/api/client'

type Pack = Schemas['Pack']
type Person = Schemas['Person']
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
    : 'nobody connects there now'
