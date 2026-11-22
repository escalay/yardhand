/**
 * Builds: Build and Refresh with AI. A build drafts a pack from its purpose and example tasks, rehearses each task with
 * the pack's read-only tools, and keeps one sealed proposal the owner accepts line by line; $1 at most on the model.
 */
import type { Feature } from '../index.js'
import { buildsHandlers } from './handlers.js'
import { routes, TAG } from './routes.js'
import { BUILDS_MIGRATIONS } from './schema.js'

export const feature: Feature = {
  name: 'builds',
  tag: {
    name: TAG,
    description:
      'Build and Refresh with AI: a pack drafted from its purpose and example tasks, tried, then accepted line by line.',
  },
  migrations: BUILDS_MIGRATIONS,
  register: (app, services) => {
    const handle = buildsHandlers(services)
    // Before `/api/packs/{name}/builds/{id}`, which would take `estimate` as an id
    app.openapi(routes.estimate, handle.estimate)
    app.openapi(routes.start, handle.start)
    app.openapi(routes.get, handle.get)
    app.openapi(routes.accept, handle.accept)
    app.openapi(routes.discard, handle.discard)
  },
  tools: [],
}
