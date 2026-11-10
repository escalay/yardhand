/** Clients: API keys and OAuth clients, their allowlists, scopes and pinned tools. */
import type { Feature } from '../index.js'
import { clientsHandlers } from './handlers.js'
import { routes, TAG } from './routes.js'
import { CLIENTS_MIGRATIONS } from './schema.js'

export const feature: Feature = {
  name: 'clients',
  tag: { name: TAG, description: 'Who may call the gateway, what each reaches and which tools it sees pinned.' },
  migrations: CLIENTS_MIGRATIONS,
  register: (app, services) => {
    const handle = clientsHandlers(services)
    app.openapi(routes.me, handle.me)
    app.openapi(routes.list, handle.list)
    app.openapi(routes.get, handle.get)
    app.openapi(routes.create, handle.create)
    app.openapi(routes.update, handle.update)
    app.openapi(routes.revoke, handle.revoke)
    app.openapi(routes.setup, handle.setup)
    app.openapi(routes.getPins, handle.getPins)
    app.openapi(routes.setPins, handle.setPins)
  },
  tools: [],
}
