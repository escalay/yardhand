/** The call log's filters, kept in the address so a filtered view can be shared or opened from an alert. */
import { parseRange, type Range, sinceOf } from '@/shell/filters.rules'

export type Outcome = 'all' | 'problems' | 'ok' | 'refused'
/** Tool calls by default; reads (a manual, a playbook, a link) or everything on request. */
export type KindFilter = 'manual' | 'playbook' | 'link' | 'all'
export type ActivitySearch = {
  outcome: Outcome
  kind?: KindFilter
  upstream?: string
  client?: string
  tool?: string
  via?: 'rest' | 'mcp' | 'passthrough' | 'app'
  /** Only calls in this window (the log's whole 90 days when absent). */
  range?: Range
  /** Only calls by keys locked to this pack. */
  pack?: string
  /** The call open in the side panel. */
  call?: string
}

const OUTCOMES: Outcome[] = ['all', 'problems', 'ok', 'refused']
const KINDS: KindFilter[] = ['manual', 'playbook', 'link', 'all']
const VIAS = ['rest', 'mcp', 'passthrough', 'app'] as const
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : undefined)

export const parseActivitySearch = (raw: Record<string, unknown>): ActivitySearch => ({
  outcome: OUTCOMES.includes(raw.outcome as Outcome) ? (raw.outcome as Outcome) : 'all',
  kind: KINDS.includes(raw.kind as KindFilter) ? (raw.kind as KindFilter) : undefined,
  upstream: text(raw.upstream),
  client: text(raw.client),
  tool: text(raw.tool),
  via: VIAS.includes(raw.via as (typeof VIAS)[number]) ? (raw.via as ActivitySearch['via']) : undefined,
  range: parseRange(raw.range),
  pack: text(raw.pack),
  call: text(raw.call),
})

/** The API's `status` filter for an outcome. */
export const statusOf = (outcome: Outcome) =>
  outcome === 'problems' ? 'tool_error,failed' : outcome === 'ok' ? 'ok' : outcome === 'refused' ? 'refused' : undefined

/** The API's `kind` filter: tool calls unless asked otherwise, everything for `all`. */
export const kindOf = (kind: KindFilter | undefined) => (kind === 'all' ? undefined : (kind ?? 'tool'))

export const KIND_LABEL: Record<string, string> = {
  tool: 'Tool calls',
  manual: 'Manual reads',
  playbook: 'Playbooks',
  link: 'Links followed',
  all: 'Everything',
}

/** Does a live call belong in the current view? */
export const matches = (
  search: ActivitySearch,
  call: { status: string; upstream: string | null; clientId: string; tool: string; via: string; kind?: string },
) => {
  const status = statusOf(search.outcome)
  const kind = kindOf(search.kind)
  return (
    (!kind || (call.kind ?? 'tool') === kind) &&
    (!status || status.split(',').includes(call.status)) &&
    (!search.upstream || call.upstream === search.upstream) &&
    (!search.client || call.clientId === search.client) &&
    (!search.tool || call.tool === search.tool) &&
    (!search.via || call.via === search.via)
  )
}

export const VIA_LABEL: Record<string, string> = {
  rest: 'REST',
  mcp: 'MCP',
  passthrough: 'Passthrough',
  app: 'This app',
}

/** How many filters narrow the view (the outcome counts when it isn't "all"). */
export const activeFilters = (search: ActivitySearch) =>
  [
    search.outcome !== 'all',
    search.kind,
    search.upstream,
    search.client,
    search.tool,
    search.via,
    search.range,
    search.pack,
  ].filter(Boolean).length

/** The search as the API's query: the window as `since`, outcomes and kinds as lists. */
export const callsQueryOf = (search: Omit<ActivitySearch, 'call'>, now = Date.now()) => ({
  status: statusOf(search.outcome),
  upstream: search.upstream,
  client: search.client,
  pack: search.pack,
  tool: search.tool,
  via: search.via,
  kind: kindOf(search.kind),
  since: sinceOf(search.range, now),
})
