/** Catalog: the manuals, playbooks and links upstreams offer besides tools, synced and reviewed like tools. */
import type { Feature } from '../index.js'
import { catalogHandlers } from './handlers.js'
import { routes, TAG } from './routes.js'
import { CATALOG_MIGRATIONS } from './schema.js'

export const feature: Feature = {
  name: 'catalog',
  tag: { name: TAG, description: 'Manuals, playbooks and links: what upstreams offer besides tools.' },
  migrations: CATALOG_MIGRATIONS,
  register: (app, services) => {
    const handlers = catalogHandlers(services)
    app.openapi(routes.playbooks, handlers.playbooks)
    app.openapi(routes.playbook, handlers.playbook)
    app.openapi(routes.messages, handlers.messages)
    app.openapi(routes.manuals, handlers.manuals)
    app.openapi(routes.manual, handlers.manual)
    app.openapi(routes.links, handlers.links)
    app.openapi(routes.resource, handlers.resource)
  },
  tools: [],
}
