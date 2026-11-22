/** The rehearsal door: logged and listed, but never counted as use. */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { migrate, testDb } from '../../kit/index.js'
import { callsRepo } from './repo.js'
import { CALLS_MIGRATIONS } from './schema.js'

const db = await testDb()
await migrate(db, 'calls', CALLS_MIGRATIONS)
const calls = callsRepo(db, randomBytes(32))
const call = (via: 'rest' | 'app' | 'rehearsal', kind: 'tool' | 'manual' = 'tool') =>
  calls.record({
    clientId: 'owner',
    clientName: 'owner',
    tool: kind === 'tool' ? 'fixture.echo' : 'fixture',
    kind,
    upstreamId: 'fixture',
    versionId: null,
    via,
    status: 'ok',
    error: null,
    durationMs: 5,
    resultBytes: 10,
  })
const since = new Date(Date.now() - 60_000).toISOString()

describe('rehearsal calls', () => {
  it('are left out of every count of use, and listed when that door is asked for', async () => {
    await call('rehearsal')
    await call('rehearsal', 'manual')
    expect(await calls.series(since, 'hour')).toEqual([])
    expect((await calls.byUpstream(since)).size).toBe(0)
    expect(await calls.byTool(since)).toEqual([])
    expect(await calls.readsSince(since)).toEqual([])
    expect(await calls.firsts()).toEqual({ agentCallAt: null, ownerRunAt: null })
    expect(await calls.window({ since })).toEqual([])
    expect(await calls.window({ since, via: 'rehearsal' })).toHaveLength(1)
    expect((await calls.page({ limit: 10 })).map((row) => row.via)).toEqual(['rehearsal', 'rehearsal'])
    expect(await calls.page({ limit: 10, via: 'rehearsal' })).toHaveLength(2)
  })

  it('leave the owner’s own run from the app counted', async () => {
    await call('app')
    expect((await calls.firsts()).ownerRunAt).not.toBeNull()
    expect(await calls.byTool(since)).toEqual([{ tool: 'fixture.echo', count: 1 }])
  })
})
