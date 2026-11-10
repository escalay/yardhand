/** Numbers and times the way the app says them: short, plain, no jargon. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "4 min ago", "3 h ago", "yesterday", "5 days ago", then the date. */
export const ago = (iso: string | null | undefined, now = Date.now()) => {
  if (!iso) return 'never'
  const ms = now - new Date(iso).getTime()
  if (ms < 45_000) return 'just now'
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min ago`
  if (ms < DAY) return `${Math.round(ms / HOUR)} h ago`
  if (ms < 2 * DAY) return 'yesterday'
  if (ms < 30 * DAY) return `${Math.floor(ms / DAY)} days ago`
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** 212 ms, 1.4 s, 2 min. */
export const duration = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return '–'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${Math.round(ms / 60_000)} min`
}

/** 512 B, 12 KB, 3.4 MB. */
export const bytes = (count: number) => {
  if (count < 1024) return `${count} B`
  if (count < 1024 * 1024) return `${Math.round(count / 1024)} KB`
  return `${(count / 1024 / 1024).toFixed(1)} MB`
}

/** "1 tool", "3 tools". */
export const plural = (count: number, word: string, many = `${word}s`) =>
  `${count.toLocaleString('en-GB')} ${count === 1 ? word : many}`

/** A clock time for today, a date and time otherwise. */
export const when = (iso: string, now = new Date()) => {
  const at = new Date(iso)
  const sameDay = at.toDateString() === now.toDateString()
  return sameDay
    ? at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : at.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
