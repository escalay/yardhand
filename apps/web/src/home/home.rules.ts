/** Pure rules for Home: app paths from the API's hrefs, and what each setup step says and offers. */
import { type Door, parseDoor, parseRange, type Range } from '@/shell/filters.rules'

/** The API names app places as `/app/...`; the router's paths start after its `/app` base. */
export const routeOf = (href: string) => href.replace(/^\/app(?=\/|$)/, '') || '/'

export const STEP_COPY: Record<string, { body: string; action: string }> = {
  connect: {
    body: 'Paste the address of an MCP server or a REST API, or start with the sample tools. Yardhand works out how it signs in.',
    action: 'Connect a server',
  },
  try: { body: 'Run one of its tools right here and see exactly what an agent would get back.', action: 'Try a tool' },
  key: {
    body: 'One key per agent or machine. It reaches only what you choose, and comes with the setup to paste.',
    action: 'Give an agent a key',
  },
  'first-call': {
    body: 'Paste the setup into Claude Code, Cursor or a script and make any call. It shows up here as it happens.',
    action: 'Watch for it',
  },
  pin: {
    body: 'Pinned tools show up in every agent’s tool list directly, no search needed. Pick the ones used most.',
    action: 'Pin tools',
  },
}

export type OverviewSearch = { range?: Range; via?: Door; compare?: false }

/** Overview's filter bar in the address; left out: a week, every door, compared with the week before. */
export const parseOverviewSearch = (raw: Record<string, unknown>): OverviewSearch => ({
  range: parseRange(raw.range),
  via: parseDoor(raw.via),
  compare: raw.compare === false || raw.compare === 'false' || raw.compare === 0 ? false : undefined,
})

/** The tallest bar sets the scale; an empty day still draws a hairline. */
export const barHeights = (values: number[]) => {
  const top = Math.max(...values, 1)
  return values.map((value) => (value ? Math.max(4, Math.round((value / top) * 100)) : 0))
}

type Findability = { searches: number; found: number; rate: number | null }

/** "84%" and "12 of 14 searches this week led to a call", or a plain line before any agent searched. */
export const findabilityOf = ({ searches, found, rate }: Findability) =>
  rate === null
    ? { headline: '–', detail: 'No agent searched for a tool this week yet.' }
    : {
        headline: `${Math.round(rate * 100)}%`,
        detail: `${found} of ${searches} search${searches === 1 ? '' : 'es'} this week led to a call.`,
      }
