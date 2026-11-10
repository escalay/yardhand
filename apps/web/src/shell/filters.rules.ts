/** The filter bar's rules: windows, doors, and how a number changed since the window before. */

export const RANGES = [
  { value: '24h', label: 'Last 24 hours', short: '24 h', ms: 24 * 3_600_000 },
  { value: '7d', label: 'Last 7 days', short: '7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: 'Last 30 days', short: '30 days', ms: 30 * 86_400_000 },
] as const
export type Range = (typeof RANGES)[number]['value']

export const DOORS = [
  { value: 'mcp', label: 'MCP' },
  { value: 'rest', label: 'REST' },
  { value: 'app', label: 'This app' },
  { value: 'passthrough', label: 'Passthrough' },
] as const
export type Door = (typeof DOORS)[number]['value']

export const parseRange = (value: unknown, fallback?: Range): Range | undefined =>
  RANGES.some((range) => range.value === value) ? (value as Range) : fallback

export const parseDoor = (value: unknown): Door | undefined =>
  DOORS.some((door) => door.value === value) ? (value as Door) : undefined

/** Where a window starts, as the API's `since`. */
export const sinceOf = (range: Range | undefined, now = Date.now()) => {
  const found = RANGES.find((option) => option.value === range)
  return found ? new Date(now - found.ms).toISOString() : undefined
}

/**
 * A number's change since the window before, in words, and whether that is good news. `lowerIsBetter` for problems
 * and time. Shares compare in points; counts and times in percent.
 */
export const changeOf = (
  now: number | null,
  before: number | null,
  { lowerIsBetter = false, points = false }: { lowerIsBetter?: boolean; points?: boolean } = {},
) => {
  if (now === null || before === null) return { text: 'nothing to compare', tone: 'neutral' as const }
  const diff = now - before
  if (diff === 0) return { text: 'same as before', tone: 'neutral' as const }
  if (!points && before === 0) return { text: 'none the window before', tone: 'neutral' as const }
  const better = lowerIsBetter ? diff < 0 : diff > 0
  const sign = diff > 0 ? '+' : '−'
  const text = points
    ? `${sign}${Math.abs(Math.round(diff * 100))} pts`
    : `${sign}${Math.abs(Math.round((diff / before) * 100))}%`
  return { text: `${text} vs before`, tone: better ? ('good' as const) : ('bad' as const) }
}

/** A share as a percentage, or a dash when there is nothing to divide. */
export const shareOf = (part: number, whole: number) => (whole ? part / whole : null)
export const percent = (share: number | null) => (share === null ? '–' : `${Math.round(share * 100)}%`)
