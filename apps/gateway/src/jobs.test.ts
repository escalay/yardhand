import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  accessNotifier,
  afterSync,
  backup,
  createJobs,
  discordPost,
  dueAt,
  type JobRun,
  reviewNotifier,
  syncAll,
} from './jobs.js'
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

describe('access notifier', () => {
  const origin = 'https://gw.example.com'
  const now = new Date('2026-12-19T12:30:00.000Z')
  const DAY_MS = 24 * 60 * 60 * 1000
  const at = (days: number, from = now) => new Date(from.getTime() + days * DAY_MS).toISOString()
  const key = (id: string, name: string, packId: string, made: number, ends: number) => ({
    id,
    name,
    packId,
    createdAt: at(made),
    expiresAt: at(ends),
    revokedAt: null,
  })
  const world = (rows: ReturnType<typeof key>[]) => {
    const state = { rows }
    const packs = [
      { id: 'pk_loud', name: 'loud', title: 'Loud' },
      { id: 'pk_desk', name: 'desk', title: 'Desk' },
    ]
    const services = { clients: { list: async () => state.rows }, packs: { list: async () => packs } } as never
    return { state, services }
  }
  const outbox = () => {
    const sent: string[] = []
    return {
      sent,
      post: async (text: string) => {
        sent.push(text)
      },
    }
  }

  it('says once who is ending, and again when an extended key is ending anew', async () => {
    const { state, services } = world([key('cl_sam', 'Sam', 'pk_loud', -27.5, 2.5)])
    const { sent, post } = outbox()
    const notify = accessNotifier(post)
    await notify(services, origin, now)
    await notify(services, origin, new Date(now.getTime() + 60 * 60 * 1000))
    expect(sent).toEqual([
      [
        '**Yardhand:** access ending soon',
        `• Sam's access to Loud ends on 22 Dec 2026. Extend it: ${origin}/app/packs/loud?tab=people (or PATCH ${origin}/api/clients/cl_sam with {"expiresIn":"30d"})`,
      ].join('\n'),
    ])
    // Extended by a week: quiet while it has more than three days, then said again with the new day
    const extended = new Date(now.getTime() + DAY_MS)
    state.rows = [{ ...key('cl_sam', 'Sam', 'pk_loud', -27.5, 0), expiresAt: at(7, extended) }]
    await notify(services, origin, extended)
    expect(sent).toHaveLength(1)
    await notify(services, origin, new Date(extended.getTime() + 5 * DAY_MS))
    expect(sent).toHaveLength(2)
    expect(sent[1]).toContain("• Sam's access to Loud ends on 27 Dec 2026.")
  })

  it('gives each person their own pack and request, and stays quiet without a webhook', async () => {
    const { services } = world([key('cl_sam', 'Sam', 'pk_loud', -27, 2), key('cl_ada', 'Ada', 'pk_desk', -29, 1)])
    const { sent, post } = outbox()
    await accessNotifier(post)(services, origin, now)
    expect(sent).toEqual([
      [
        '**Yardhand:** access ending soon',
        `• Ada's access to Desk ends on 20 Dec 2026. Extend it: ${origin}/app/packs/desk?tab=people (or PATCH ${origin}/api/clients/cl_ada with {"expiresIn":"30d"})`,
        `• Sam's access to Loud ends on 21 Dec 2026. Extend it: ${origin}/app/packs/loud?tab=people (or PATCH ${origin}/api/clients/cl_sam with {"expiresIn":"30d"})`,
      ].join('\n'),
    ])
    await accessNotifier(null)(services, origin, now)
    expect(sent).toHaveLength(1)
  })

  it('keeps a person to their one line, whatever their name or the pack’s title holds', async () => {
    const state = { rows: [key('cl_sam', 'Sam\r\n**Yardhand:** pay here\u2028now', 'pk_loud', -27, 2)] }
    const packs = [{ id: 'pk_loud', name: 'loud', title: 'Loud\n\nand clear' }]
    const services = { clients: { list: async () => state.rows }, packs: { list: async () => packs } } as never
    const { sent, post } = outbox()
    await accessNotifier(post)(services, origin, now)
    expect(sent[0]?.split('\n')).toEqual([
      '**Yardhand:** access ending soon',
      `• Sam **Yardhand:** pay here now's access to Loud and clear ends on 21 Dec 2026. Extend it: ${origin}/app/packs/loud?tab=people (or PATCH ${origin}/api/clients/cl_sam with {"expiresIn":"30d"})`,
    ])
    expect(sent[0]).not.toMatch(/[\r\u2028\u2029]/)
  })

  it('remembers across restarts only what is still ending, and says it again when the webhook failed', async () => {
    const stored: { keys?: string[] } = {}
    const kept = {
      load: async () => stored.keys,
      save: async (keys: string[]) => {
        stored.keys = keys
      },
    }
    const sam = key('cl_sam', 'Sam', 'pk_loud', -27, 2)
    const { state, services } = world([sam])
    const { sent, post } = outbox()
    const down = accessNotifier(() => Promise.reject(new Error('Discord webhook answered 500')), kept)
    await expect(down(services, origin, now)).rejects.toThrow('answered 500')
    expect(stored.keys).toBeUndefined()
    await accessNotifier(post, kept)(services, origin, now)
    expect(stored.keys).toEqual([`cl_sam:${sam.expiresAt}`])
    // A restart: nothing is said twice
    await accessNotifier(post, kept)(services, origin, now)
    expect(sent).toHaveLength(1)
    state.rows = []
    await accessNotifier(post, kept)(services, origin, now)
    expect(stored.keys).toEqual([])
  })

  it('keeps one message within what Discord takes, and says the rest on the next run', async () => {
    const long = (index: number) => `${'A very long name '.repeat(4)}${index}`
    const { services } = world(
      Array.from({ length: 12 }, (_, index) => key(`cl_${index}`, long(index), 'pk_loud', -27, 2)),
    )
    const { sent, post } = outbox()
    const notify = accessNotifier(post)
    await notify(services, origin, now)
    await notify(services, origin, now)
    await notify(services, origin, now)
    expect(sent.length).toBeGreaterThan(1)
    expect(sent.every((text) => text.length <= 2000)).toBe(true)
    expect(sent.join('\n').match(/• A very long name/g)).toHaveLength(12)
  })
})

describe('the Discord webhook', () => {
  it('posts the text and lets it ping nobody, whatever names it carries', async () => {
    const asked: { url: string; body: unknown }[] = []
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      asked.push({ url, body: JSON.parse(init.body) })
      return new Response(null, { status: 204 })
    })
    try {
      await discordPost('https://discord.example.test/hook')?.('@everyone Sam <@&1>')
      expect(asked).toEqual([
        {
          url: 'https://discord.example.test/hook',
          body: { content: '@everyone Sam <@&1>', allowed_mentions: { parse: [] } },
        },
      ])
      expect(discordPost(undefined)).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the sync job', () => {
  it('runs every notice after a sync that failed, and still fails with what the sync said', async () => {
    const ran: string[] = []
    const failed = afterSync(() => Promise.reject(new Error('1 of 2 connections synced; failed: almanac')), {
      'review notice': async () => {
        ran.push('reviews')
      },
      'access notice': async () => {
        ran.push('access')
      },
    })
    await expect(failed).rejects.toThrow('1 of 2 connections synced; failed: almanac')
    expect(ran).toEqual(['reviews', 'access'])
  })

  it('says what the sync said when a notice fails, and still runs the notice after it', async () => {
    const ran: string[] = []
    const said = await afterSync(async () => '2 connections synced', {
      'review notice': () => Promise.reject(new Error('Discord webhook answered 500')),
      'access notice': async () => {
        ran.push('access')
      },
    })
    expect(said).toBe('2 connections synced')
    expect(ran).toEqual(['access'])
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
