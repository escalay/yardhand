/** Backup routes (owner only): download a copy of the database, and restore the gateway from one. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'

export const PATH = '/api/system/backups'
export const TAG = 'Backups'
export const SQLITE = 'application/vnd.sqlite3'

const file = z
  .string()
  .max(80)
  .openapi({
    param: { name: 'file', in: 'path' },
    description: 'A backup’s file name, as `GET /api/system` lists them.',
    example: 'state-2026-11-10.sqlite',
  })
const RestoreQuery = z.object({
  dryRun: z.enum(['true', 'false']).optional().openapi({
    description: '`true` only checks the file and says what it holds: nothing is staged, nothing restarts.',
  }),
  force: z.enum(['true', 'false']).optional().openapi({
    description:
      '`true` restores a file whose secrets this master key can’t open; every connection then needs its key again.',
  }),
})
const RestoreSchema = z
  .object({
    from: z.string().openapi({ description: 'The backup’s file name, or `upload`.' }),
    bytes: z.number().int(),
    connections: z.number().int(),
    tools: z.number().int(),
    agents: z.number().int(),
    secrets: z.enum(['readable', 'unreadable', 'none']).openapi({
      description:
        'Whether this gateway’s master key opens the file’s sealed keys and tokens. `unreadable`: it was sealed under another `GATEWAY_MASTER_KEY`.',
    }),
    staged: z.boolean().openapi({ description: 'False for a dry run.' }),
    kept: z.string().nullable().openapi({
      description: 'The copy of the data from before the restore, in the backups folder: restore it to go back.',
    }),
    restart: z.enum(['now', 'manual', 'none']).openapi({
      description:
        '`now`: the gateway restarts itself in a moment and comes back restored. `manual`: restart it to finish. `none`: a dry run.',
    }),
    _links: LinksSchema,
  })
  .openapi('Restore', { description: 'What a backup holds, and whether it was staged to replace the database.' })

const restored = {
  200: {
    content: { [HAL_JSON]: { schema: RestoreSchema } },
    description: 'What the file holds, and what happens next.',
  },
  ...problemResponses(400, 401, 403, 404, 409),
}
const RESTORE_HELP =
  'The file is checked first, today’s data is kept as `before-restore-<time>.sqlite`, and the gateway takes the file up at its next start (it restarts itself where it can). Everything is replaced: connections, tools, agents and their keys, packs, the call log. Refused (409) when its secrets were sealed under another master key, unless `force=true`'

export const routes = {
  download: createRoute({
    method: 'get',
    path: `${PATH}/{file}`,
    operationId: 'downloadBackup',
    tags: [TAG],
    summary: 'Download a backup',
    description:
      'One of the kept copies of the database, as a SQLite file. It holds everything; keys and tokens in it stay sealed under the master key (owner only).',
    request: { params: z.object({ file }) },
    responses: {
      200: {
        content: { [SQLITE]: { schema: z.string().openapi({ format: 'binary' }) } },
        description: 'The SQLite file.',
      },
      ...problemResponses(401, 403, 404),
    },
  }),
  restoreKept: createRoute({
    method: 'post',
    path: `${PATH}/{file}/restores`,
    operationId: 'restoreBackup',
    tags: [TAG],
    summary: 'Restore a kept backup',
    description: `Restores the gateway from one of its kept backups. ${RESTORE_HELP} (owner only).`,
    request: { params: z.object({ file }), query: RestoreQuery },
    responses: restored,
  }),
  restoreUpload: createRoute({
    method: 'post',
    path: '/api/system/restores',
    operationId: 'restoreUpload',
    tags: [TAG],
    summary: 'Restore from a file',
    description: `Restores the gateway from a SQLite file sent as the body: how a new instance takes over another’s data (give it the same \`GATEWAY_MASTER_KEY\` first). ${RESTORE_HELP} (owner only).`,
    request: {
      query: RestoreQuery,
      body: {
        required: true,
        content: { [SQLITE]: { schema: z.string().openapi({ format: 'binary' }) } },
        description: 'The SQLite file, as downloaded from a gateway.',
      },
    },
    responses: restored,
  }),
}
