/** The API's entry point: what the gateway is and a link to everything, so a client can start from one URL. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'

export const PATH = '/api'
export const TAG = 'Home'

const HomeSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string(),
    upstreams: z.number().int().openapi({ description: 'Upstreams this client may use.' }),
    _links: LinksSchema,
  })
  .openapi('Home', { description: 'The gateway and links to every part of it.' })

export const routes = {
  home: createRoute({
    method: 'get',
    path: PATH,
    operationId: 'getHome',
    tags: [TAG],
    summary: 'Start here',
    description:
      'What the gateway is, and links to tools, upstreams, calls, the tools as OpenAPI, the guide and MCP. Inside a pack (its key, or its address `/p/<pack>/api`) it is the pack: its title, what it is for, and at its address links that stay under it.',
    responses: {
      200: { content: { [HAL_JSON]: { schema: HomeSchema } }, description: 'The entry point.' },
      ...problemResponses(401, 403),
    },
  }),
}
