/** Backups: download a copy of the database, restore the gateway from a kept copy or an uploaded file. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'hono'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import { requireOwner } from '../clients/principals.js'
import type { Feature } from '../index.js'
import { backupPath, inspect, NotABackup, stage } from './restore.js'
import { PATH, routes, SQLITE, TAG } from './routes.js'

/** The most a restore upload may be. */
const MAX_BYTES = 1024 * 1024 * 1024

export const feature: Feature = {
  name: 'backups',
  tag: { name: TAG, description: 'Copies of the gateway’s database: download one, restore from one.' },
  migrations: [],
  register: (app, { db, env, vault, restart }) => {
    const stateDir = env.STATE_DIR ?? '.state'
    const keptOf = (file: string) => {
      const path = backupPath(stateDir, file)
      if (!path) throw new ProblemError('not_found', { detail: `No backup ${file}. GET /api/system lists them.` })
      return path
    }
    /** Checks a file, and unless it is a dry run stages it and restarts. */
    const restore = async (
      c: Context,
      from: string,
      source: string | Uint8Array,
      query: { dryRun?: string; force?: string },
    ) => {
      // An upload is checked from a file of its own, outside the state folder
      const scratch = typeof source === 'string' ? null : mkdtempSync(join(tmpdir(), 'gateway-restore-'))
      const path = typeof source === 'string' ? source : join(scratch as string, 'upload.sqlite')
      if (typeof source !== 'string') writeFileSync(path, source)
      try {
        const holds = (() => {
          try {
            return inspect(path, vault.opens)
          } catch (error) {
            if (error instanceof NotABackup) throw new ProblemError('bad_request', { detail: error.message })
            throw error
          }
        })()
        const dryRun = query.dryRun === 'true'
        if (!dryRun && holds.secrets === 'unreadable' && query.force !== 'true')
          throw new ProblemError('conflict', {
            detail:
              'Its keys and tokens were sealed under another master key, so this gateway couldn’t use any connection that signs in. Start this gateway with that instance’s GATEWAY_MASTER_KEY, or restore with force=true and give each connection its key again.',
          })
        const kept = dryRun ? null : await stage(db, stateDir, path)
        // After the answer is out: the process ends, and its supervisor (Docker, compose) starts it restored
        if (!dryRun && restart.current) setTimeout(restart.current, 500).unref()
        return c.json(
          {
            from,
            ...holds,
            staged: !dryRun,
            kept,
            restart: dryRun ? ('none' as const) : restart.current ? ('now' as const) : ('manual' as const),
            _links: linksOf(originOf(c), { self: c.req.path, system: '/api/system' }),
          },
          200,
        )
      } finally {
        if (scratch) rmSync(scratch, { recursive: true, force: true })
      }
    }

    app.openapi(routes.download, async (c) => {
      requireOwner(c)
      const { file } = c.req.valid('param')
      return new Response(readFileSync(keptOf(file)), {
        headers: { 'content-type': SQLITE, 'content-disposition': `attachment; filename="${file}"` },
      }) as never
    })
    app.openapi(routes.restoreKept, async (c) => {
      requireOwner(c)
      const { file } = c.req.valid('param')
      return restore(c, file, keptOf(file), c.req.valid('query'))
    })
    app.openapi(routes.restoreUpload, async (c) => {
      requireOwner(c)
      const body = new Uint8Array(await c.req.arrayBuffer())
      if (!body.length)
        throw new ProblemError('bad_request', { detail: `Send the SQLite file as the body (content-type ${SQLITE}).` })
      if (body.length > MAX_BYTES)
        throw new ProblemError('bad_request', { detail: 'That file is over 1 GB: restore it on the server instead.' })
      return restore(c, 'upload', body, c.req.valid('query'))
    })
  },
  tools: [],
}

export { PATH }
