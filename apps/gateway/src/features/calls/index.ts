/** Calls: running tools through the pipeline, and the call log. */
import type { Feature } from '../index.js'
import { callsHandlers } from './handlers.js'
import { routes, TAG } from './routes.js'
import { CALLS_MIGRATIONS } from './schema.js'

export const feature: Feature = {
  name: 'calls',
  tag: { name: TAG, description: 'Run tools through the gateway, and read the call log.' },
  migrations: CALLS_MIGRATIONS,
  register: (app, services) => {
    const handle = callsHandlers(services)
    app.openapi(routes.call, handle.call)
    app.openapi(routes.callNamed, handle.callNamed)
    app.openapi(routes.list, handle.list)
    // Before `/api/calls/{id}`, which would take `export` as an id
    app.openapi(routes.export, handle.exportCsv)
    app.openapi(routes.get, handle.get)
    app.openapi(routes.result, handle.result)
    app.openapi(routes.payload, handle.payload)
  },
  tools: [],
}
