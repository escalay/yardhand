/** AI: the gateway's AI jobs (search by meaning, smart grouping), set from .env and from Settings. */
import type { Feature } from '../index.js'
import { aiHandlers } from './handlers.js'
import { routes, TAG } from './routes.js'

export const feature: Feature = {
  name: 'ai',
  tag: { name: TAG, description: 'The gateway’s AI jobs and their providers, keys and models.' },
  migrations: [],
  register: (app, services) => {
    const handle = aiHandlers(services)
    // Before `/api/ai/{job}`, which would take `models` as a job
    app.openapi(routes.models, handle.models)
    app.openapi(routes.get, handle.get)
    app.openapi(routes.update, handle.update)
    app.openapi(routes.test, handle.test)
  },
  tools: [],
}
