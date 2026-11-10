/**
 * The numbers behind the filter bar: one window of tool calls (24 h, 7 days or 30 days) and the window before it, as
 * tiles with their change, a series by outcome, and ranked lists. Pure: the caller hands in the rows.
 */
import { bucketsOf } from './rules.js'

export const RANGES = {
  '24h': { ms: 24 * 3_600_000, bucket: 'hour', size: 24 },
  '7d': { ms: 7 * 86_400_000, bucket: 'day', size: 7 },
  '30d': { ms: 30 * 86_400_000, bucket: 'day', size: 30 },
} as const
export type Range = keyof typeof RANGES

export type StatRow = {
  status: string
  durationMs: number
  createdAt: string
  tool: string
  clientId: string
  clientName: string
  upstreamId: string | null
}

const PROBLEMS = new Set(['tool_error', 'refused', 'failed'])

const median = (values: number[]) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? 0
  return sorted.length % 2 ? upper : Math.round(((sorted[middle - 1] ?? upper) + upper) / 2)
}

/** Calls, problems and the median time of the calls that reached their upstream. */
export const tilesOf = (rows: StatRow[]) => ({
  calls: rows.length,
  problems: rows.filter((row) => PROBLEMS.has(row.status)).length,
  medianMs: median(
    rows.filter((row) => row.status === 'ok' || row.status === 'tool_error').map((row) => row.durationMs),
  ),
})

/** Rows grouped by a key, counted with their problems, most first. */
const ranked = <Key extends string>(rows: StatRow[], keyOf: (row: StatRow) => Key | null, limit: number) => {
  const groups = new Map<Key, { calls: number; problems: number; durations: number[]; label: string }>()
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) continue
    const entry = groups.get(key) ?? { calls: 0, problems: 0, durations: [], label: row.clientName }
    entry.calls++
    if (PROBLEMS.has(row.status)) entry.problems++
    if (row.status === 'ok' || row.status === 'tool_error') entry.durations.push(row.durationMs)
    groups.set(key, entry)
  }
  return [...groups]
    .sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, entry]) => ({ key, ...entry, medianMs: median(entry.durations) }))
}

/** Splits rows into this window and the one before, and shapes everything the filter bar shows. */
export const statsOf = (rows: StatRow[], { now, range }: { now: Date; range: Range }) => {
  const { ms, bucket, size } = RANGES[range]
  const since = new Date(now.getTime() - ms).toISOString()
  const current = rows.filter((row) => row.createdAt >= since)
  const before = rows.filter((row) => row.createdAt < since)
  const width = bucket === 'hour' ? 13 : 10
  const counts = new Map<string, number>()
  for (const row of current) {
    const key = `${row.createdAt.slice(0, width)}|${row.status}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return {
    since,
    previousSince: new Date(now.getTime() - 2 * ms).toISOString(),
    bucket,
    tiles: { now: tilesOf(current), before: tilesOf(before) },
    series: bucketsOf(
      [...counts].map(([key, count]) => {
        const [at = '', status = ''] = key.split('|')
        return { at, status, count }
      }),
      { now, bucket, size },
    ),
    tools: ranked(current, (row) => row.tool, 8).map((entry) => ({
      name: entry.key,
      calls: entry.calls,
      problems: entry.problems,
    })),
    agents: ranked(current, (row) => row.clientId, 8).map((entry) => ({
      id: entry.key,
      name: entry.label,
      calls: entry.calls,
      problems: entry.problems,
    })),
    upstreams: ranked(current, (row) => row.upstreamId, 20).map((entry) => ({
      id: entry.key,
      calls: entry.calls,
      problems: entry.problems,
      medianMs: entry.medianMs,
    })),
  }
}
