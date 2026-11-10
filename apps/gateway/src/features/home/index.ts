/** Home: the entry point at /api. */
import { linksOf, originOf } from '../../kit/index.js'
import { VERSION } from '../../version.js'
import { allows, callerOf } from '../clients/principals.js'
import type { Feature } from '../index.js'
import { PATH, routes, TAG } from './routes.js'

export const feature: Feature = {
  name: 'home',
  tag: { name: TAG, description: 'The entry point: start here and follow the links.' },
  migrations: [],
  register: (app, { principals, upstreams }) => {
    app.openapi(routes.home, async (c) => {
      const principal = await principals.require(callerOf(c))
      const reachable = (await upstreams.list()).filter((row) => row.enabled && allows(principal, row.id)).length
      const owner = principal.owner ? { clients: '/api/clients', reviews: '/api/reviews', pins: '/api/pins' } : {}
      return c.json(
        {
          name: 'Yardhand',
          version: VERSION,
          description:
            'One endpoint for every tool: find a tool by what you want to do, read its schema, run it. Over REST here, or MCP at /mcp.',
          upstreams: reachable,
          _links: linksOf(originOf(c), {
            self: PATH,
            me: '/api/me',
            tools: '/api/tools',
            toolsOpenapi: '/api/tools/openapi.json',
            upstreams: '/api/upstreams',
            calls: '/api/calls',
            ...owner,
            openapi: '/openapi.json',
            docs: '/docs',
            guide: '/llms.txt',
            mcp: '/mcp',
          }),
        },
        200,
      )
    })
  },
  tools: [],
}
