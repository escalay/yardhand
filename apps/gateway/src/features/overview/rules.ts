/** Pure rules behind Home: where setup stands, and what needs the owner. No queries here. */

export type SetupFacts = {
  liveUpstreams: number
  ownerRunAt: string | null
  keyClients: number
  agentCallAt: string | null
  globalPins: number
}

export type SetupStep = {
  id: 'connect' | 'try' | 'key' | 'first-call' | 'pin'
  title: string
  done: boolean
  href: string
}

/** The activation path: connect, try, hand out a key, see an agent's first call, pin what's used. */
export const setupOf = (facts: SetupFacts) => {
  const steps: SetupStep[] = [
    { id: 'connect', title: 'Connect your first server', done: facts.liveUpstreams > 0, href: '/app/connections/new' },
    { id: 'try', title: 'Try one of its tools here', done: Boolean(facts.ownerRunAt), href: '/app/tools' },
    { id: 'key', title: 'Give an agent a key', done: facts.keyClients > 0, href: '/app/agents/new' },
    { id: 'first-call', title: 'See its first call', done: Boolean(facts.agentCallAt), href: '/app/activity' },
    { id: 'pin', title: 'Pin the tools agents use most', done: facts.globalPins > 0, href: '/app/tools?pinned=1' },
  ]
  const done = steps.filter((step) => step.done).length
  return {
    steps,
    done,
    total: steps.length,
    complete: done === steps.length,
    next: steps.find((step) => !step.done)?.id ?? null,
  }
}

export type NudgeFacts = {
  now: Date
  keyClients: { id: string; name: string; createdAt: string; lastCallAt: string | null }[]
  upstreams: {
    id: string
    title: string
    status: string
    lastError: string | null
    createdAt: string
    calls30d: number
  }[]
  pendingReviews: number
  /** Smart grouping: whether it is set up, and connections whose groups still come from the rules, by size. */
  grouping?: { ready: boolean; byRules: { id: string; title: string; tools: number }[] }
  /** Pack wordings whose tool its server has since rewritten. */
  packFlags?: number
}

export type Nudge = {
  kind: 'reviews' | 'pack_wording' | 'failing_upstream' | 'quiet_key' | 'unused_upstream' | 'smart_grouping'
  /** One sentence the owner can act on. */
  message: string
  action: string
  href: string
}

const DAY_MS = 24 * 60 * 60 * 1000
const ageDays = (now: Date, at: string) => (now.getTime() - new Date(at).getTime()) / DAY_MS
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** What needs the owner, most urgent first: reviews, failing servers, keys never used, servers nobody calls. */
/** Connections big enough that model-made groups are worth it. */
const GROUPING_WORTH = 15

/** One nudge toward smart grouping: set it up, or regroup the biggest connection still grouped by rules. */
const groupingNudge = (grouping: NudgeFacts['grouping']) => {
  const biggest = [...(grouping?.byRules ?? [])]
    .filter((upstream) => upstream.tools >= GROUPING_WORTH)
    .sort((a, b) => b.tools - a.tools)[0]
  if (!grouping || !biggest) return []
  return [
    grouping.ready
      ? {
          kind: 'smart_grouping' as const,
          message: `${biggest.title}'s ${biggest.tools} tools are grouped by rules. Let the model group them by what they do: you see a preview first.`,
          action: 'Preview',
          href: `/app/connections/${biggest.id}`,
        }
      : {
          kind: 'smart_grouping' as const,
          message: `${biggest.title} has ${biggest.tools} tools in groups found by rules. Set up smart grouping (2 minutes) so a model names them by what they do.`,
          action: 'Set up',
          href: '/app/settings',
        },
  ]
}

export const nudgesOf = ({
  now,
  keyClients,
  upstreams,
  pendingReviews,
  packFlags = 0,
  grouping,
}: NudgeFacts): Nudge[] => [
  ...(pendingReviews
    ? [
        {
          kind: 'reviews' as const,
          message: `${plural(pendingReviews, 'change')} ${pendingReviews === 1 ? 'waits' : 'wait'} for your review. Agents keep the approved version until you decide.`,
          action: 'Review',
          href: '/app/tools/reviews',
        },
      ]
    : []),
  ...(packFlags
    ? [
        {
          kind: 'pack_wording' as const,
          message: `${plural(packFlags, 'tool')} you worded in a pack ${packFlags === 1 ? 'was' : 'were'} rewritten by ${packFlags === 1 ? 'its server' : 'their servers'}. Agents keep your wording until you recheck it.`,
          action: 'Recheck',
          href: '/app/tools/reviews',
        },
      ]
    : []),
  ...upstreams
    .filter((upstream) => upstream.status === 'failing')
    .map((upstream) => ({
      kind: 'failing_upstream' as const,
      message: `${upstream.title} isn't answering${upstream.lastError ? `: ${upstream.lastError.slice(0, 140)}` : '.'}`,
      action: 'Open',
      href: `/app/connections/${upstream.id}`,
    })),
  ...keyClients
    .filter((client) => !client.lastCallAt && ageDays(now, client.createdAt) >= 1)
    .map((client) => ({
      kind: 'quiet_key' as const,
      message: `${client.name}'s key hasn't made a call since it was made ${Math.floor(ageDays(now, client.createdAt))} days ago. Paste its setup into the agent.`,
      action: 'Show setup',
      href: `/app/agents/${client.id}`,
    })),
  ...upstreams
    .filter(
      (upstream) => upstream.status === 'live' && upstream.calls30d === 0 && ageDays(now, upstream.createdAt) >= 30,
    )
    .map((upstream) => ({
      kind: 'unused_upstream' as const,
      message: `No agent called ${upstream.title} in 30 days. Keep it, or remove it to shorten every search.`,
      action: 'Open',
      href: `/app/connections/${upstream.id}`,
    })),
  ...groupingNudge(grouping),
]

/** Buckets for a chart: every hour (or day) in the window, zero-filled, oldest first. */
export const bucketsOf = (
  rows: { at: string; status: string; count: number }[],
  { now, bucket, size }: { now: Date; bucket: 'hour' | 'day'; size: number },
) => {
  const step = bucket === 'hour' ? 60 * 60 * 1000 : DAY_MS
  const width = bucket === 'hour' ? 13 : 10
  const keys = Array.from({ length: size }, (_, index) =>
    new Date(now.getTime() - (size - 1 - index) * step).toISOString().slice(0, width),
  )
  const byKey = new Map(keys.map((key) => [key, { at: key, total: 0, errors: 0 }]))
  for (const row of rows) {
    const entry = byKey.get(row.at)
    if (!entry) continue
    entry.total += Number(row.count)
    if (row.status === 'failed' || row.status === 'tool_error') entry.errors += Number(row.count)
  }
  return [...byKey.values()]
}
