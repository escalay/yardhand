/**
 * Upgrades that can be undone: the version that last ran is kept beside the data (`<state>/version`). When a newer
 * one starts, the database is copied into `backups/before-<new version>.sqlite` before any migration touches it. An
 * older one refuses to start on data a newer one wrote, since its schema may not read it.
 *
 * A newer version that never came up leaves its copy behind and never records itself. When this version then starts
 * (a rollback, by whatever put the old version back: the updater, `helm rollback`, a pinned image), the data may be
 * half migrated, so that copy takes the database's place first. What the failed version left is kept aside.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const FILE = 'version'

/** -1, 0 or 1, comparing `major.minor.patch` (anything after a `-` or `+` is ignored). */
export const compareVersions = (a: string, b: string) => {
  const parts = (version: string) => (version.split(/[-+]/)[0] ?? '').split('.').map((part) => Number(part) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let index = 0; index < 3; index++) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0)
    if (difference) return Math.sign(difference)
  }
  return 0
}

const BEFORE = /^before-(\d+\.\d+\.\d+)\.sqlite$/

/**
 * Takes the data back from before an update that never came up: the copy a version newer than `running` made, while
 * the version on record is not that newer one. Returns the version that failed, or null when there is none.
 */
const undoFailedUpgrade = (stateDir: string, databaseFile: string, running: string) => {
  const dir = join(stateDir, 'backups')
  if (!existsSync(dir)) return null
  const failed = readdirSync(dir)
    .flatMap((name) => {
      const version = BEFORE.exec(name)?.[1]
      return version && compareVersions(version, running) > 0 ? [version] : []
    })
    .sort(compareVersions)
    .at(-1)
  if (!failed) return null
  // What the failed version left goes aside, with its write-ahead log, which belongs to it and not to the copy
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(dir, `failed-${failed}.sqlite${suffix}`), { force: true })
    if (existsSync(`${databaseFile}${suffix}`))
      renameSync(`${databaseFile}${suffix}`, join(dir, `failed-${failed}.sqlite${suffix}`))
  }
  renameSync(join(dir, `before-${failed}.sqlite`), databaseFile)
  return failed
}

/**
 * Before the database opens: backs it up when this version is newer than the one that last ran, and says why not
 * to start when it is older. An update that never came up is undone first (`undone` names its version). `stamp`
 * records this version once the server is up.
 */
export const prepareUpgrade = (stateDir: string, databaseFile: string, running: string) => {
  const path = join(stateDir, FILE)
  const last = existsSync(path) ? readFileSync(path, 'utf8').trim() : null
  const stamp = () => writeFileSync(path, `${running}\n`)
  // Without a version on record nothing is known about this data, so nothing is undone
  if (!last || !existsSync(databaseFile)) return { problem: null, backup: null, undone: null, stamp }
  const order = compareVersions(running, last)
  if (order < 0)
    return {
      problem: `This data was last run by Yardhand ${last}, newer than this ${running}. Run ${last} or later, or restore a backup from before the upgrade (Settings › Backups, or backups/before-${last}.sqlite).`,
      backup: null,
      undone: null,
      stamp,
    }
  const undone = undoFailedUpgrade(stateDir, databaseFile, running)
  if (order === 0) return { problem: null, backup: null, undone, stamp }
  const dir = join(stateDir, 'backups')
  mkdirSync(dir, { recursive: true })
  const backup = join(dir, `before-${running}.sqlite`)
  if (!existsSync(backup)) {
    const db = new DatabaseSync(databaseFile)
    try {
      db.exec(`vacuum into '${backup.replaceAll("'", "''")}'`)
    } finally {
      db.close()
    }
  }
  return { problem: null, backup, undone, stamp }
}
