/** Groups: a connection's tools by group and by effect, each with a switch that holds for tools added later. */
import type { Feature } from '../index.js'
import { groupsHandlers } from './handlers.js'
import { routes, TAG } from './routes.js'

export const feature: Feature = {
  name: 'groups',
  tag: { name: TAG, description: 'A connection’s tools by group and by effect, switched on or off together.' },
  migrations: [],
  register: (app, services) => {
    const handle = groupsHandlers(services)
    app.openapi(routes.list, handle.list)
    app.openapi(routes.create, handle.create)
    app.openapi(routes.update, handle.update)
    app.openapi(routes.remove, handle.remove)
    app.openapi(routes.effect, handle.effect)
    app.openapi(routes.move, handle.move)
    app.openapi(routes.regroup, handle.regroup)
    app.openapi(routes.apply, handle.apply)
  },
  tools: [],
}
