/**
 * Yardhand: one endpoint for every tool. The kit gives the agent-ready API (auth, OAuth, OpenAPI, guide, MCP);
 * the features add upstreams, tools, clients and calls; `mcp/` is what agents see. This file only wires them.
 *
 * @example
 * const app = await createApp({ db: await openDb('file:.state/state.sqlite'), env: process.env })
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTraceparent, traceContext } from './features/calls/traces.js'
import { packChoice, withPackAddresses } from './features/clients/pack-choice.js'
import { callerOf } from './features/clients/principals.js'
import { FEATURES } from './features/index.js'
import { createSessionAuth, sessionFeature, type Unclaimed } from './features/session/index.js'
import { sessionsRepo } from './features/session/repo.js'
import type { MeaningSearch } from './features/tools/meaning.js'
import { GUIDE_FILES } from './guide.gen.js'
import {
  accessOwner,
  createAgentApi,
  createOAuth,
  type Db,
  dbGuardStore,
  dbOAuthStore,
  frontDoorOpen,
  migrate,
  parseApiKeys,
  rateLimit,
  serveFrontDoor,
  serveGuide,
} from './kit/index.js'
import { mountPassthrough } from './mcp/passthrough.js'
import { mountProxy } from './mcp/proxy.js'
import { mountGatewayMcp } from './mcp/server.js'
import { createServices, type Env } from './services.js'
import { VERSION } from './version.js'

export { META_TOOLS as TOOLS } from './mcp/tools.js'
export type { Env }
export { VERSION }

const DESCRIPTION = [
  'One endpoint for every tool: MCP servers and APIs behind the gateway, each reached with credentials stored once.',
  '',
  '- **Auth:** `Authorization: Bearer <key>` (one key per client), or an OAuth token the owner approves.',
  '- **Find tools:** `GET /api/tools?q=<what you want to do>`, then `GET /api/tools/{name}` for the input schema.',
  '- **Run one:** `POST /api/calls` with `{ "tool": "<name>", "arguments": { … } }`.',
  '- **Agent guide:** [/llms.txt](/llms.txt). **MCP:** `/mcp`.',
].join('\n')

/** The browser app's pages under /app: open, since they hold no data (the API behind them checks every call). */
const APP_PAGES = [
  '',
  'welcome',
  'setup',
  'connections',
  'tools',
  'packs',
  'agents',
  'activity',
  'reviews',
  'settings',
  'sign-in',
]
const DEFAULT_WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist')

export const createApp = async ({
  db,
  env,
  meaning,
  unclaimed,
}: {
  db: Db
  env: Env
  meaning?: MeaningSearch
  /** An instance nobody owns yet waits here for its setup code (see `features/instance`). */
  unclaimed?: Unclaimed
}) => {
  const access = env.ACCESS_TEAM && env.ACCESS_AUD ? { team: env.ACCESS_TEAM, audience: env.ACCESS_AUD } : undefined
  const keys = parseApiKeys(env.API_KEYS)
  const sessions = sessionsRepo(db)
  const waiting = { current: unclaimed ?? null }
  const session = sessionFeature({ keys, sessions, access: Boolean(access), unclaimed: waiting })
  const features = [...FEATURES, session]
  for (const feature of features) await migrate(db, feature.name, feature.migrations)
  const sessionAuth = createSessionAuth({ keys, sessions })
  const services = await createServices({ db, env, keys, ...(meaning ? { meaning } : {}) })
  const web = { dir: env.WEB_DIR ?? DEFAULT_WEB_DIR }
  const hasWeb = existsSync(join(web.dir, 'index.html'))
  // The OAuth callback stays behind sign-in: only the pages themselves are open
  const pages = APP_PAGES.flatMap((page) => (page ? [`/app/${page}`, `/app/${page}/*`] : ['/app', '/app/']))
  const oauth = env.OAUTH_SIGNING_KEY
    ? createOAuth({
        name: 'Yardhand',
        signingKey: env.OAUTH_SIGNING_KEY,
        store: await dbOAuthStore(db),
        owner: access ? accessOwner(access) : async () => null,
      })
    : undefined
  const app = createAgentApi({
    title: 'Yardhand',
    version: VERSION,
    description: DESCRIPTION,
    tags: features.map((feature) => feature.tag),
    home: hasWeb ? false : 'docs',
    // Client keys join `keys` at boot and when made; /api/calls checks write scope per tool, so read tokens may POST it
    auth: {
      realm: 'gateway',
      keys,
      access,
      relay: ['/mcp', '/a2a', '/api/calls'],
      open: [
        '/api/session',
        '/api/session/claim',
        '/app/illustrations/*',
        ...(hasWeb ? [...frontDoorOpen(web), ...pages] : []),
      ],
    },
    oauth,
    guards: { store: await dbGuardStore(db) },
  })
  // The pack a request asks for (`/mcp/p/<pack>` or `x-gateway-pack`), on the caller before any route reads it
  app.use('*', packChoice)
  // A pack address the key doesn't open is refused at the door, saying which packs it does open
  app.use('/mcp', async (c, next) => {
    const caller = callerOf(c)
    if (caller?.pack) await services.principals.require(caller)
    await next()
  })
  // Per caller: runs reach paid and rate-limited upstreams, so a runaway agent stops here first
  const runs = rateLimit({ policy: 'tool-calls', limit: 300, windowSeconds: 60, store: await dbGuardStore(db) })
  app.on('POST', ['/api/calls', '/api/tools/:name/calls', '/u/:upstream/mcp'], runs)
  // Ten tries a minute per address: owner keys are long, but a guess should still be slow
  app.on(
    'POST',
    ['/api/session', '/api/session/claim'],
    rateLimit({ policy: 'sign-in', limit: 10, windowSeconds: 60, store: await dbGuardStore(db) }),
  )
  // The caller's W3C trace context (a `traceparent` header; MCP's `_meta.traceparent` arrives as one): calls join it
  app.use('/api/*', (c, next) => traceContext.run(parseTraceparent(c.req.header('traceparent')), next))
  for (const feature of features) feature.register(app, services)
  serveGuide(app, { files: GUIDE_FILES, vars: () => ({}), full: ['llms.txt'] })
  const mcp = mountGatewayMcp(app, services, {
    allowedHostnames: [new URL(services.publicOrigin).hostname, 'localhost', '127.0.0.1'],
  })
  // Agents listening on /mcp are told when what they see changed, so they list again instead of waiting out a cache
  services.events.subscribe((event) => {
    if (event.type !== 'lists') return
    if (event.data.tools) mcp.notify.toolsChanged()
    if (event.data.prompts) mcp.notify.promptsChanged()
    if (event.data.resources) mcp.notify.resourcesChanged()
  })
  mountPassthrough(app, services)
  mountProxy(app, services)
  // Last: whatever no route answered is a page of the app
  if (hasWeb) serveFrontDoor(app, web)
  app.fetch = withPackAddresses(sessionAuth.wrap(app.fetch as never) as typeof app.fetch)
  return Object.assign(app, { services })
}
