/** Upstreams: the servers behind the gateway, their credentials and their sync. */
import type { Feature } from '../index.js'
import { upstreamsHandlers } from './handlers.js'
import { routes, TAG } from './routes.js'
import { UPSTREAMS_MIGRATIONS } from './schema.js'

export const feature: Feature = {
  name: 'upstreams',
  tag: { name: TAG, description: 'The servers behind the gateway: add, change, sync and remove them.' },
  migrations: UPSTREAMS_MIGRATIONS,
  register: (app, services) => {
    const handle = upstreamsHandlers(services)
    app.openapi(routes.list, handle.list)
    app.openapi(routes.probe, handle.probe)
    app.openapi(routes.get, handle.get)
    app.openapi(routes.create, handle.create)
    app.openapi(routes.update, handle.update)
    app.openapi(routes.remove, handle.remove)
    app.openapi(routes.sync, handle.sync)
    app.openapi(routes.accounts, handle.accounts)
  },
  tools: [],
}
