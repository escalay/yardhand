/**
 * Backups: a kept copy downloads as a SQLite file; a restore checks the file, keeps today's data aside, stages the
 * file and takes it up at the next start; a file that isn't a gateway's, or sealed under another key, is refused.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { applyPending } from '../src/features/backups/restore.js'
import { backup } from '../src/jobs.js'
import { hashApiKey, openDb } from '../src/kit/index.js'

const OWNER = 'owner-key-for-backups'
const start = async (stateDir: string, masterKey = randomBytes(32).toString('base64')) => {
  const file = join(stateDir, 'state.sqlite')
  const app = await createApp({
    db: await openDb(`file:${file}`),
    env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: masterKey, STATE_DIR: stateDir },
  })
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { authorization: `Bearer ${OWNER}`, ...init.headers } })
  const json = async (path: string, init: RequestInit = {}) => {
    const response = await request(path, init)
    return { status: response.status, json: (await response.json()) as any }
  }
  const post = (path: string, body: unknown) =>
    json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { app, file, request, json, post, masterKey }
}
const connection = (id: string) => ({
  id,
  kind: 'http',
  url: 'http://127.0.0.1:9/api',
  http: { endpoints: [{ name: 'getThing', method: 'get', path: '/thing', description: 'A thing.' }] },
  auth: { type: 'bearer', value: 'upstream-secret' },
  trust: 'trusted',
})

describe('backups', () => {
  it('downloads a kept backup, and restores it at the next start with today’s data kept aside', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'gateway-backups-'))
    const gateway = await start(stateDir)
    await gateway.post('/api/upstreams', connection('first'))
    const day = new Date('2026-11-09T03:00:00Z')
    await backup(gateway.app.services, stateDir, day)
    await gateway.post('/api/upstreams', connection('second'))

    const download = await gateway.request('/api/system/backups/state-2026-11-09.sqlite')
    expect(download.headers.get('content-type')).toBe('application/vnd.sqlite3')
    expect(download.headers.get('content-disposition')).toContain('state-2026-11-09.sqlite')
    expect(
      Buffer.from(await download.arrayBuffer())
        .subarray(0, 15)
        .toString(),
    ).toBe('SQLite format 3')
    expect((await gateway.request('/api/system/backups/..%2Fstate.sqlite')).status).toBe(404)

    const dry = await gateway.json('/api/system/backups/state-2026-11-09.sqlite/restores?dryRun=true', {
      method: 'POST',
    })
    expect(dry.json).toMatchObject({ connections: 1, secrets: 'readable', staged: false, restart: 'none', kept: null })
    expect(applyPending(stateDir, gateway.file)).toBe(false)

    const restored = await gateway.json('/api/system/backups/state-2026-11-09.sqlite/restores', { method: 'POST' })
    // No supervisor in a test, so it asks for a restart instead of ending the process
    expect(restored.json).toMatchObject({ staged: true, restart: 'manual' })
    expect(restored.json.kept).toMatch(/^before-restore-\d{8}T\d{6}Z\.sqlite$/)
    expect(readdirSync(join(stateDir, 'backups'))).toContain(restored.json.kept)
    // Still today's data until the next start
    expect((await gateway.json('/api/upstreams')).json.count).toBe(2)

    expect(applyPending(stateDir, gateway.file)).toBe(true)
    expect(existsSync(`${gateway.file}-wal`)).toBe(false)
    const after = await start(stateDir, gateway.masterKey)
    const ids = (await after.json('/api/upstreams')).json._embedded.upstreams.map((row: { id: string }) => row.id)
    expect(ids).toEqual(['first'])
    // And the way back is the copy kept before the restore
    const back = await after.json(`/api/system/backups/${restored.json.kept}/restores?dryRun=true`, { method: 'POST' })
    expect(back.json.connections).toBe(2)
  })

  it('brings another instance’s file in by upload, refusing one sealed under another master key', async () => {
    const source = await start(mkdtempSync(join(tmpdir(), 'gateway-source-')))
    await source.post('/api/upstreams', connection('theirs'))
    const copy = await backup(source.app.services, mkdtempSync(join(tmpdir(), 'gateway-copy-')))
    const upload = (gateway: Awaited<ReturnType<typeof start>>, query = '') =>
      gateway.json(`/api/system/restores${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/vnd.sqlite3' },
        body: new Blob([readFileSync(copy)]),
      })

    const stranger = await start(mkdtempSync(join(tmpdir(), 'gateway-stranger-')))
    expect((await upload(stranger, '?dryRun=true')).json).toMatchObject({ connections: 1, secrets: 'unreadable' })
    const refused = await upload(stranger)
    expect(refused.status).toBe(409)
    expect(refused.json.detail).toContain('GATEWAY_MASTER_KEY')
    expect((await upload(stranger, '?force=true')).json).toMatchObject({ staged: true, secrets: 'unreadable' })

    const twinDir = mkdtempSync(join(tmpdir(), 'gateway-twin-'))
    const twin = await start(twinDir, source.masterKey)
    expect((await upload(twin)).json).toMatchObject({ from: 'upload', staged: true, secrets: 'readable' })
    applyPending(twinDir, twin.file)
    const ids = (await (await start(twinDir, source.masterKey)).json('/api/upstreams')).json._embedded.upstreams
    expect(ids.map((row: { id: string }) => row.id)).toEqual(['theirs'])
  })

  it('refuses a file that isn’t a gateway’s database, saying what it is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-odd-'))
    const gateway = await start(dir)
    const send = (body: BodyInit) =>
      gateway.json('/api/system/restores', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/vnd.sqlite3' },
      })
    const text = await send('{"not": "a database"}')
    expect(text.status).toBe(400)
    expect(text.json.detail).toMatch(/SQLite/)
    const other = join(dir, 'other.sqlite')
    new DatabaseSync(other).exec('create table notes (id text)')
    const foreign = await send(new Blob([readFileSync(other)]))
    expect(foreign.status).toBe(400)
    expect(foreign.json.detail).toContain('not a gateway’s')
    expect(applyPending(dir, gateway.file)).toBe(false)
  })
})
