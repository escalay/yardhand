/** Searches: every tool search is logged, so the owner sees what agents wanted and didn't find. */
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import { requireOwner } from '../clients/principals.js'
import type { Feature } from '../index.js'
import { searchLog, unansweredSearches } from './demand.js'
import { LOG_PATH, PATH, routes, TAG } from './routes.js'
import { SEARCHES_MIGRATIONS } from './schema.js'

const DAY_MS = 24 * 60 * 60 * 1000

export const feature: Feature = {
  name: 'searches',
  tag: { name: TAG, description: 'What agents searched for, and what came of it.' },
  migrations: SEARCHES_MIGRATIONS,
  register: (app, { searches, calls, clients, packs }) => {
    app.openapi(routes.log, async (c) => {
      requireOwner(c)
      const { days, client, pack: packName, unanswered, limit } = c.req.valid('query')
      const pack = packName ? await packs.get(packName) : undefined
      if (packName && !pack)
        throw new ProblemError('not_found', { detail: `No pack ${packName}. GET /api/packs lists them.` })
      const clientIds = pack
        ? (await clients.list()).filter((row) => row.packId === pack.id).map((row) => row.id)
        : client
          ? [client]
          : undefined
      const entries = await searchLog(
        { searches, calls },
        {
          since: new Date(Date.now() - days * DAY_MS).toISOString(),
          ...(clientIds ? { clientIds } : {}),
          limit: unanswered === 'true' ? 2000 : limit,
        },
      )
      const shown = (unanswered === 'true' ? entries.filter((entry) => !entry.followedBy) : entries).slice(0, limit)
      return c.json(
        {
          count: shown.length,
          days,
          _links: linksOf(originOf(c), { self: `${LOG_PATH}?days=${days}`, unanswered: PATH }),
          _embedded: { searches: shown },
        },
        200,
      )
    })
    app.openapi(routes.unanswered, async (c) => {
      requireOwner(c)
      const { days, limit } = c.req.valid('query')
      const found = await unansweredSearches(
        { searches, calls },
        new Date(Date.now() - days * DAY_MS).toISOString(),
        limit,
      )
      return c.json(
        {
          count: found.length,
          days,
          _links: linksOf(originOf(c), { self: `${PATH}?days=${days}`, tools: '/api/tools' }),
          _embedded: { searches: found },
        },
        200,
      )
    })
  },
  tools: [],
}
