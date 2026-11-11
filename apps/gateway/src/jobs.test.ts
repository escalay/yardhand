import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { backup, createJobs, dueAt, type JobRun, reviewNotifier, syncAll } from './jobs.js'
import { migrate, openDb } from './kit/index.js'

describe('backup', () => {
  it('writes a consistent copy named by day and keeps the newest seven', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-'))
    const db = await openDb(`file:${join(dir, 'state.sqlite')}`)
    await migrate(db, 'demo', ['create table if not exists demo (id text primary key)'])
    seedOldBackups(dir)
    const file = await backup({ db }, dir, new Date('2026-11-08T03:00:00Z'))
    expect(existsSync(file)).toBe(true)
    const kept = readdirSync(join(dir, 'backups')).sort()
    expect(kept).toHaveLength(7)
    expect(kept.at(-1)).toBe('state-2026-11-08.sqlite')
    expect(kept[0]).toBe('state-2026-11-02.sqlite')
  })
})

const seedOldBackups = (dir: string) => {
  const backups = join(dir, 'backups')
  mkdirSync(backups, { recursive: true })
  for (let day = 1; day <= 7; day++) writeFileSync(join(backups, `state-2026-11-0${day}.sqlite`), '')
}

describe('review notifier', () => {
  it('announces each pending version once, and stays quiet without a webhook', async () => {
    const sent: string[] = []
    let pending = [{ tool: { name: 'weather.forecast', liveVersion: 'tv_1' }, version: { id: 'tv_2' } }]
    const tools = { pending: async () => pending } as never
    let catalogPending: unknown[] = []
    const catalog = { pending: async () => catalogPending } as never
    const notify = reviewNotifier(async (text) => {
      sent.push(text)
    })
    await notify({ tools, catalog }, 'https://gateway.example.test')
    await notify({ tools, catalog }, 'https://gateway.example.test')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/1 change waiting for review/)
    expect(sent[0]).toMatch(/weather\.forecast \(changed tool, version tv_2\)/)
    pending = [...pending, { tool: { name: 'weather.tides', liveVersion: null }, version: { id: 'tv_3' } }] as never
    await notify({ tools, catalog }, 'https://gateway.example.test')
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatch(/weather\.tides \(new tool/)
    catalogPending = [{ item: { name: 'cookbook', kind: 'manual', liveVersion: 'cv_1' }, version: { id: 'cv_2' } }]
    await notify({ tools, catalog }, 'https://gateway.example.test')
    expect(sent[2]).toMatch(/cookbook \(changed manual, version cv_2\)/)
    await reviewNotifier(null)({ tools, catalog }, 'https://gateway.example.test')
  })
})

describe('the schedule', () => {
  const HOUR = 3_600_000
  it('is due by when a job last ran: a day after a backup, within the hour after a failure, now if never', () => {
    const at = '2026-11-10T03:00:00.000Z'
    const then = new Date(at).getTime()
    expect(dueAt('backup', undefined)).toBe(0)
    expect(dueAt('backup', { at, ok: true })).toBe(then + 24 * HOUR)
    expect(dueAt('backup', { at, ok: false })).toBe(then + HOUR)
    expect(dueAt('sync', { at, ok: true })).toBe(then + HOUR)
  })

  it('runs only what is due, remembers each run across restarts, and says what failed', async () => {
    const stored: { all?: Record<string, JobRun> } = {}
    const kept = {
      load: async () => stored.all,
      save: async (all: Record<string, JobRun>) => {
        stored.all = all
      },
    }
    let backups = 0
    const work = {
      sync: async () => {
        throw new Error('1 of 2 connections synced; failed: almanac')
      },
      backup: async () => `${++backups} MB backed up`,
      usage: async () => 'Off: GATEWAY_TELEMETRY is off',
      updates: async () => 'Up to date: 0.2.0 is the newest',
    }
    const first = createJobs(work, new Map(), kept)
    await first.load()
    await first.tick()
    expect(first.view()).toMatchObject([
      { name: 'sync', ok: false, detail: '1 of 2 connections synced; failed: almanac', running: false },
      { name: 'backup', ok: true, detail: '1 MB backed up' },
      { name: 'usage', ok: true, detail: 'Off: GATEWAY_TELEMETRY is off' },
      { name: 'updates', ok: true, detail: 'Up to date: 0.2.0 is the newest' },
    ])
    // A restart: the backup isn't due again today, the failed sync is within the hour
    const second = createJobs(work, new Map(), kept)
    await second.load()
    await second.tick()
    expect(backups).toBe(1)
    await second.tick(Date.now() + 25 * HOUR)
    expect(backups).toBe(2)
    // Run now joins a run already going
    const both = [second.run('backup'), second.run('backup')]
    await Promise.all(both)
    expect(backups).toBe(3)
  })

  it('syncs every enabled connection and names the ones that failed', async () => {
    const upstreams = {
      list: async () => [
        { id: 'a', enabled: true },
        { id: 'b', enabled: true },
        { id: 'c', enabled: false },
      ],
    }
    const ok = { upstreams, sync: async () => ({}) } as unknown as Parameters<typeof syncAll>[0]
    expect(await syncAll(ok)).toBe('2 connections synced')
    const bad = {
      upstreams,
      sync: async (id: string) => (id === 'b' ? Promise.reject(new Error('down')) : {}),
    } as unknown as Parameters<typeof syncAll>[0]
    await expect(syncAll(bad)).rejects.toThrow('1 of 2 connections synced; failed: b')
  })
})
