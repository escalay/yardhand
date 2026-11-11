/** Upgrades: a newer version backs the data up before migrating; an older one refuses data a newer one wrote. */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

  describe('an update that never came up', () => {
    /** A newer version starts on the data, copies it, writes something, and dies before it is up. */
    const failedUpdate = (stateDir: string, databaseFile: string, version: string) => {
      prepareUpgrade(stateDir, databaseFile, version)
      new DatabaseSync(databaseFile).exec('create table half_migrated (x)')
    }
    const tables = (file: string) => {
      const db = new DatabaseSync(file, { readOnly: true })
      const names = (db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map(
        (row) => row.name,
      )
      db.close()
      return names
    }

    it('is undone when the old version starts again: the data from before, and what was left kept aside', () => {
      const { stateDir, databaseFile } = instance('0.2.0')
      failedUpdate(stateDir, databaseFile, '0.3.0')
      const back = prepareUpgrade(stateDir, databaseFile, '0.2.0')
      expect(back).toMatchObject({ problem: null, undone: '0.3.0' })
      expect(tables(databaseFile)).toEqual(['notes'])
      expect(tables(join(stateDir, 'backups', 'failed-0.3.0.sqlite'))).toContain('half_migrated')
      // The copy is used up, so the next start has nothing to undo and the next try at 0.3.0 makes a fresh one
      expect(existsSync(join(stateDir, 'backups', 'before-0.3.0.sqlite'))).toBe(false)
      expect(prepareUpgrade(stateDir, databaseFile, '0.2.0').undone).toBeNull()
    })

    it('is undone before a version in between upgrades, so its copy holds whole data', () => {
      const { stateDir, databaseFile } = instance('0.2.0')
      failedUpdate(stateDir, databaseFile, '0.4.0')
      const next = prepareUpgrade(stateDir, databaseFile, '0.3.0')
      expect(next.undone).toBe('0.4.0')
      expect(tables(next.backup as string)).toEqual(['notes'])
    })

    it('leaves alone the copies of updates that worked, and data with no version on record', () => {
      const { stateDir, databaseFile } = instance('0.2.0')
      prepareUpgrade(stateDir, databaseFile, '0.3.0').stamp()
      new DatabaseSync(databaseFile).exec('create table written_since (x)')
      expect(prepareUpgrade(stateDir, databaseFile, '0.3.0').undone).toBeNull()
      expect(tables(databaseFile)).toContain('written_since')

      const fresh = instance()
      mkdirSync(join(fresh.stateDir, 'backups'))
      writeFileSync(join(fresh.stateDir, 'backups', 'before-0.9.0.sqlite'), 'left by something else')
      expect(prepareUpgrade(fresh.stateDir, fresh.databaseFile, '0.2.0').undone).toBeNull()
    })

    it('still refuses a newer version’s data once that version did come up', () => {
      const { stateDir, databaseFile } = instance('0.2.0')
      prepareUpgrade(stateDir, databaseFile, '0.3.0').stamp()
      const back = prepareUpgrade(stateDir, databaseFile, '0.2.0')
      expect(back.problem).toContain('newer than this 0.2.0')
      expect(back.undone).toBeNull()
      expect(existsSync(join(stateDir, 'backups', 'before-0.3.0.sqlite'))).toBe(true)
    })
  })
})
