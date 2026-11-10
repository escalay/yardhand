/**
 * Upgrades that can be undone: the version that last ran is kept beside the data (`<state>/version`). When a newer
 * one starts, the database is copied into `backups/before-<new version>.sqlite` before any migration touches it. An
 * older one refuses to start on data a newer one wrote, since its schema may not read it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/**
 * Before the database opens: backs it up when this version is newer than the one that last ran, and says why not
 * to start when it is older. `stamp` records this version once the server is up.
 */
export const prepareUpgrade = (stateDir: string, databaseFile: string, running: string) => {
  const path = join(stateDir, FILE)
  const last = existsSync(path) ? readFileSync(path, 'utf8').trim() : null
  const stamp = () => writeFileSync(path, `${running}\n`)
  if (!last || !existsSync(databaseFile)) return { problem: null, backup: null, stamp }
  const order = compareVersions(running, last)
  if (order < 0)
    return {
      problem: `This data was last run by Yardhand ${last}, newer than this ${running}. Run ${last} or later, or restore a backup from before the upgrade (Settings › Backups, or backups/before-${last}.sqlite).`,
      backup: null,
      stamp,
    }
  if (order === 0) return { problem: null, backup: null, stamp }
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
  return { problem: null, backup, stamp }
}
