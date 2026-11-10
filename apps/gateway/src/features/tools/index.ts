/** Tools: the registry of upstream tools, keyword search over it, and review of third-party changes. */
import type { Feature } from '../index.js'
import { toolsHandlers } from './handlers.js'
import { routes, TAG } from './routes.js'
import { TOOLS_MIGRATIONS } from './schema.js'

export const feature: Feature = {
  name: 'tools',
  tag: { name: TAG, description: 'Find and describe tools across every upstream; review changed third-party tools.' },
  migrations: TOOLS_MIGRATIONS,
  register: (app, services) => {
    const handle = toolsHandlers(services)
    app.openapi(routes.openapi, handle.openapi)
    app.openapi(routes.list, handle.list)
    app.openapi(routes.reviews, handle.reviews)
    app.openapi(routes.decideAll, handle.decideAll)
    app.openapi(routes.decide, handle.decide)
    app.openapi(routes.get, handle.get)
    app.openapi(routes.setAccess, handle.setAccess)
  },
  tools: [],
}
