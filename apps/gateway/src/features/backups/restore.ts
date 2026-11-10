/**
 * Backups as files, and restoring one. A restore never swaps the database under a running server: the file is checked
 * (a whole SQLite file, a gateway's, its secrets readable with this master key), today's data is copied aside as
 * `before-restore-<time>.sqlite`, the file is staged, and the server takes it up at its next start (`applyPending`).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sql } from 'drizzle-orm'
import type { Db } from '../../kit/index.js'

/** A file in the backups folder: a daily copy, or the copy kept before a restore or an upgrade. */
export const BACKUP_FILE =
  /^(state-\d{4}-\d{2}-\d{2}|before-restore-\d{8}T\d{6}Z|before-\d+\.\d+\.\d+(-[\w.]+)?)\.sqlite$/
const PENDING = 'restore.pending.sqlite'
const KEEP_BEFORE = 3
const NEEDS = ['kit_migrations', 'upstreams', 'tools', 'clients', 'secrets']

export const backupsDir = (stateDir: string) => join(stateDir, 'backups')

/** A backup's path, or null when the name isn't one or the file is gone. */
export const backupPath = (stateDir: string, file: string) => {
  const path = join(backupsDir(stateDir), file)
  return BACKUP_FILE.test(file) && existsSync(path) ? path : null
}

export class NotABackup extends Error {}

/** What a database file holds, read without changing it; throws `NotABackup` saying what is wrong with it. */
export const inspect = (path: string, opens: (sealed: string) => boolean) => {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch {
    throw new NotABackup('That file can’t be opened as a SQLite database.')
  }
  try {
    const one = <T>(query: string) => db.prepare(query).get() as T
    let whole: string
    try {
      whole = one<{ integrity_check: string }>('pragma integrity_check').integrity_check
    } catch {
      throw new NotABackup('That file isn’t a SQLite database.')
    }
    if (whole !== 'ok') throw new NotABackup(`That database is damaged (${whole.slice(0, 120)}).`)
    const tables = new Set(
      (db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map(
        (row) => row.name,
      ),
    )
    const missing = NEEDS.filter((name) => !tables.has(name))
    if (missing.length)
      throw new NotABackup(`That is a SQLite database, but not a gateway’s: it has no ${missing.join(', ')} table.`)
    const count = (query: string) => Number(one<{ n: number }>(query).n)
    const sealed = (db.prepare('select sealed from secrets limit 5').all() as { sealed: string }[]).map(
      (row) => row.sealed,
    )
    return {
      bytes: statSync(path).size,
      connections: count('select count(*) as n from upstreams'),
      tools: count('select count(*) as n from tools where removed_at is null'),
      agents: count('select count(*) as n from clients'),
      /** Its sealed values open with this gateway's master key (`none`: it holds no secrets). */
      secrets: (sealed.length ? (sealed.every(opens) ? 'readable' : 'unreadable') : 'none') as
        | 'readable'
        | 'unreadable'
        | 'none',
    }
  } finally {
    db.close()
  }
}

const stamp = (now: Date) =>
  now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')

/**
 * Stages a file for the next start: copies today's data aside first (a consistent `VACUUM INTO`), then puts the file
 * where `applyPending` finds it. Returns the name of the copy kept.
 */
export const stage = async (db: Db, stateDir: string, source: string | Uint8Array, now = new Date()) => {
  const dir = backupsDir(stateDir)
  mkdirSync(dir, { recursive: true })
  const kept = `before-restore-${stamp(now)}.sqlite`
  await db.run(sql.raw(`vacuum into '${join(dir, kept).replaceAll("'", "''")}'`))
  for (const old of readdirSync(dir)
    .filter((name) => name.startsWith('before-restore-'))
    .sort()
    .slice(0, -KEEP_BEFORE))
    rmSync(join(dir, old))
  const pending = join(stateDir, PENDING)
  if (typeof source === 'string') copyFileSync(source, pending)
  else writeFileSync(pending, source)
  return kept
}

/** At start, before the database opens: a staged restore takes the database's place. Returns whether one did. */
export const applyPending = (stateDir: string, databaseFile: string) => {
  const pending = join(stateDir, PENDING)
  if (!existsSync(pending)) return false
  // The old write-ahead log belongs to the old database: left behind, SQLite would replay it into the new one
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${databaseFile}${suffix}`, { force: true })
  renameSync(pending, databaseFile)
  return true
}
