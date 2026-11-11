/** Pure rules for the scheduled jobs and backups in Settings: what each is, said in words. */

export const JOBS = {
  sync: { title: 'Sync every connection', does: 'Every hour: reads what each server offers now.' },
  backup: { title: 'Back up and clean up', does: 'Every day: copies the database, drops calls older than 90 days.' },
  usage: {
    title: 'Send the usage report',
    does: 'Every day: an anonymous report, unless switched off (GATEWAY_TELEMETRY=off).',
  },
} as const

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** "next in 57 min", "next in 21 h", "due now". */
export const nextLine = (iso: string, now = Date.now()) => {
  const ms = new Date(iso).getTime() - now
  if (ms < MINUTE) return 'due now'
  return ms < HOUR ? `next in ${Math.round(ms / MINUTE)} min` : `next in ${Math.round(ms / HOUR)} h`
}

/** "0.1.0 · 8275d96": the version with the commit it was built from, when the image says. */
export const versionLine = (version: string, build: string | null) =>
  build ? `${version} · ${build.slice(0, 7)}${build.endsWith('-dirty') ? ' (uncommitted)' : ''}` : version

/** What a file in the backups folder is, from its name. */
export const backupKind = (file: string) => {
  if (file.startsWith('before-restore-')) return 'Kept before a restore'
  const upgrade = /^before-(\d+\.\d+\.\d+[^/]*)\.sqlite$/.exec(file)?.[1]
  return upgrade ? `Kept before upgrading to ${upgrade}` : 'Daily backup'
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "It holds 3 connections, 40 tools and 3 agents." */
export const holdsLine = (holds: { connections: number; tools: number; agents: number }) =>
  `It holds ${count(holds.connections, 'connection')}, ${count(holds.tools, 'tool')} and ${count(holds.agents, 'agent')}.`
