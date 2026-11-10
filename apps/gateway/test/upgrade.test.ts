/** Upgrades: a newer version backs the data up before migrating; an older one refuses data a newer one wrote. */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { BACKUP_FILE } from '../src/features/backups/restore.js'
import { compareVersions, prepareUpgrade } from '../src/features/instance/upgrade.js'

const instance = (version?: string) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'yardhand-upgrade-'))
  const databaseFile = join(stateDir, 'state.sqlite')
  new DatabaseSync(databaseFile).exec("create table notes (id text); insert into notes values ('kept')")
  if (version) writeFileSync(join(stateDir, 'version'), `${version}\n`)
  return { stateDir, databaseFile }
}

describe('upgrades', () => {
  it('orders versions by number, not by text', () => {
    expect(compareVersions('0.10.0', '0.9.3')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(0)
    expect(compareVersions('0.2.1', '0.2.10')).toBe(-1)
  })

  it('backs the data up once before a newer version migrates it, then records the version', () => {
    const { stateDir, databaseFile } = instance('0.1.0')
    const first = prepareUpgrade(stateDir, databaseFile, '0.2.0')
    expect(first.problem).toBeNull()
    expect(first.backup).toBe(join(stateDir, 'backups', 'before-0.2.0.sqlite'))
    expect(existsSync(first.backup as string)).toBe(true)
    // Settings › Backups lists it and restores it like any other
    expect(BACKUP_FILE.test('before-0.2.0.sqlite')).toBe(true)
    const copy = new DatabaseSync(first.backup as string, { readOnly: true })
    expect(copy.prepare('select id from notes').get()).toEqual({ id: 'kept' })
    copy.close()
    first.stamp()
    expect(prepareUpgrade(stateDir, databaseFile, '0.2.0').backup).toBeNull()
  })

  it('refuses data a newer version wrote, saying how to get back', () => {
    const { stateDir, databaseFile } = instance('0.3.0')
    const { problem } = prepareUpgrade(stateDir, databaseFile, '0.2.0')
    expect(problem).toContain('newer than this 0.2.0')
    expect(problem).toContain('backups/before-0.3.0.sqlite')
  })

  it('needs nothing on a first start', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'yardhand-upgrade-'))
    expect(prepareUpgrade(stateDir, join(stateDir, 'state.sqlite'), '0.1.0')).toMatchObject({
      problem: null,
      backup: null,
    })
  })
})
