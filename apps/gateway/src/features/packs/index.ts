/**
 * Packs: curated kits of tools, playbooks and manuals, each with its own wording, that a key can be locked to, and
 * the playbooks and skill written for each (`own.*`).
 */
import type { Feature } from '../index.js'
import { packsHandlers } from './handlers.js'
import { ownHandlers } from './own.handlers.js'
import { ownRoutes } from './own.routes.js'
import { routes, TAG } from './routes.js'
import { PACKS_MIGRATIONS } from './schema.js'

export const feature: Feature = {
  name: 'packs',
  tag: { name: TAG, description: 'Packs: a kit of tools for one kind of work that a key can be locked to.' },
  migrations: PACKS_MIGRATIONS,
  register: (app, services) => {
    const handlers = packsHandlers(services)
    // Before `/api/packs/{name}`, which would take `flags` as a name
    app.openapi(routes.flags, handlers.flags)
    app.openapi(routes.list, handlers.list)
    app.openapi(routes.create, handlers.create)
    app.openapi(routes.variables, handlers.variables)
    app.openapi(routes.get, handlers.get)
    app.openapi(routes.setup, handlers.setup)
    app.openapi(routes.update, handlers.update)
    app.openapi(routes.remove, handlers.remove)
    app.openapi(routes.freeName, handlers.freeName)
    app.openapi(routes.wording, handlers.wording)
    app.openapi(routes.entry, handlers.entry)
    app.openapi(routes.uses, handlers.uses)
    const own = ownHandlers(services)
    app.openapi(ownRoutes.listPlaybooks, own.listPlaybooks)
    app.openapi(ownRoutes.createPlaybook, own.createPlaybook)
    app.openapi(ownRoutes.getPlaybook, own.getPlaybook)
    app.openapi(ownRoutes.setPlaybook, own.setPlaybook)
    app.openapi(ownRoutes.removePlaybook, own.removePlaybook)
    app.openapi(ownRoutes.getSkill, own.getSkill)
    app.openapi(ownRoutes.setSkill, own.setSkill)
    app.openapi(ownRoutes.removeSkill, own.removeSkill)
    app.openapi(ownRoutes.check, own.check)
  },
  tools: [],
}
