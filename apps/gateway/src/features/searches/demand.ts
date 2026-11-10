/**
 * Searches nothing came of: the agent searched, then called none of the tools it found in the next ten minutes (or it
 * found none).
 * Grouped by what was asked, most asked first: what to connect next, from what agents actually looked for.
 */
import type { CallsRepo } from '../calls/repo.js'
import type { SearchesRepo } from './repo.js'

const ANSWER_WINDOW_MS = 10 * 60 * 1000

export type Unanswered = { query: string; count: number; clients: string[]; lastAt: string; results: number }

type Sources = { searches: SearchesRepo; calls: Pick<CallsRepo, 'calledAnyOf'> }
type LogSources = { searches: SearchesRepo; calls: Pick<CallsRepo, 'firstCallOf'> }

/** Each search since a moment, and whether the agent then called a tool it found. */
const outcomesOf = async ({ searches, calls }: Sources, since: string) =>
  Promise.all(
    (await searches.since(since)).map(async (row) => {
      const until = new Date(new Date(row.createdAt).getTime() + ANSWER_WINDOW_MS).toISOString()
      const found = JSON.parse(row.tools) as string[]
      return { row, answered: found.length > 0 && (await calls.calledAnyOf(row.clientId, found, row.createdAt, until)) }
    }),
  )

export type Findability = { searches: number; found: number; rate: number | null }

const rateOf = (searches: number, found: number): Findability => ({
  searches,
  found,
  rate: searches ? found / searches : null,
})

/** How often agents' searches led to a tool they then called: overall and per client. */
export const findability = async (sources: Sources, since: string) => {
  const outcomes = await outcomesOf(sources, since)
  const byClient = new Map<string, { searches: number; found: number }>()
  for (const { row, answered } of outcomes) {
    const tally = byClient.get(row.clientId) ?? { searches: 0, found: 0 }
    tally.searches++
    if (answered) tally.found++
    byClient.set(row.clientId, tally)
  }
  return {
    overall: rateOf(outcomes.length, outcomes.filter((outcome) => outcome.answered).length),
    of: (clientId: string) => {
      const tally = byClient.get(clientId)
      return rateOf(tally?.searches ?? 0, tally?.found ?? 0)
    },
  }
}

export const unansweredSearches = async (sources: Sources, since: string, limit: number, clientIds?: string[]) => {
  const groups = new Map<string, Unanswered>()
  for (const { row, answered } of await outcomesOf(sources, since)) {
    if (answered || (clientIds && !clientIds.includes(row.clientId))) continue
    const group = groups.get(row.normalized) ?? {
      query: row.query,
      count: 0,
      clients: [],
      lastAt: row.createdAt,
      results: row.results,
    }
    group.count++
    if (!group.clients.includes(row.clientName)) group.clients.push(row.clientName)
    groups.set(row.normalized, group)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, limit)
}

export type SearchEntry = {
  id: string
  query: string
  clientId: string
  client: string
  via: string
  results: number
  /** The first tools it found, best first. */
  tools: string[]
  /** The tool it called next (within ten minutes) among those it found, or null: nothing came of it. */
  followedBy: string | null
  at: string
}

/** Agents' searches since a moment, newest first, each with what the agent called next. */
export const searchLog = async (
  { searches, calls }: LogSources,
  { since, clientIds, limit }: { since: string; clientIds?: string[]; limit: number },
): Promise<SearchEntry[]> => {
  const rows = (await searches.since(since, 5000)).filter((row) => !clientIds || clientIds.includes(row.clientId))
  return Promise.all(
    rows.slice(0, limit).map(async (row) => {
      const found = JSON.parse(row.tools) as string[]
      const until = new Date(new Date(row.createdAt).getTime() + ANSWER_WINDOW_MS).toISOString()
      return {
        id: row.id,
        query: row.query,
        clientId: row.clientId,
        client: row.clientName,
        via: row.via,
        results: row.results,
        tools: found.slice(0, 5),
        followedBy: (await calls.firstCallOf(row.clientId, found, row.createdAt, until)) ?? null,
        at: row.createdAt,
      }
    }),
  )
}
