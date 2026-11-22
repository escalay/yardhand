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
import type { Model } from './features/ai/model.js'
import { parseTraceparent, traceContext } from './features/calls/traces.js'
import { withPlaybookQuery } from './features/catalog/query.js'
import { packChoice, withPackAddresses } from './features/clients/pack-choice.js'
import { callerOf, isOwner } from './features/clients/principals.js'
import { FEATURES } from './features/index.js'
import { mountPackDocs } from './features/packs/docs.js'
import { createSessionAuth, kitOwner, sessionFeature, type Unclaimed } from './features/session/index.js'
import { sessionsRepo } from './features/session/repo.js'
import { signInLog } from './features/session/sign-ins.js'
import type { MeaningSearch } from './features/tools/meaning.js'
import { sealedGuardStore } from './features/vault/answers.js'
import { parseMasterKey } from './features/vault/crypto.js'
import { GUIDE_FILES } from './guide.gen.js'
import { GUIDE_VARS } from './guide.vars.js'
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
  model,
  unclaimed,
}: {
  db: Db
  env: Env
  meaning?: MeaningSearch
  /** The model Build with AI asks; tests and the demo pass a scripted one. */
  model?: Model
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
  const services = await createServices({ db, env, keys, ...(meaning ? { meaning } : {}), ...(model ? { model } : {}) })
  const web = { dir: env.WEB_DIR ?? DEFAULT_WEB_DIR }
  const hasWeb = existsSync(join(web.dir, 'index.html'))
  // The OAuth callback stays behind sign-in: only the pages themselves are open
  const pages = APP_PAGES.flatMap((page) => (page ? [`/app/${page}`, `/app/${page}/*`] : ['/app', '/app/']))
  const oauthStore = env.OAUTH_SIGNING_KEY ? await dbOAuthStore(db) : undefined
  const oauth =
    env.OAUTH_SIGNING_KEY && oauthStore
      ? createOAuth({
          name: 'Yardhand',
          signingKey: env.OAUTH_SIGNING_KEY,
          store: oauthStore,
          // The owner's own session approves an app's sign-in too; claims and device codes need Access
          owner: async (c) => (await kitOwner(sessions)(c)) ?? (access ? await accessOwner(access)(c) : null),
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
    // An answer kept for an `Idempotency-Key` can hold a key shown once: it is kept sealed
    guards: { store: await sealedGuardStore(db, parseMasterKey(env.GATEWAY_MASTER_KEY)) },
  })
  // The pack a request asks for (its address `/p/<pack>/…` or `x-gateway-pack`), on the caller before any route reads
  // it; a name the pack used to have is read as the one it has now
  app.use(
    '*',
    packChoice((name) => services.packs.currentNameOf(name)),
  )
  // A pack address the key doesn't open is refused at the door, saying which packs it does open. A key whose access
  // has ended goes on: it connects and is told why, in the instructions and by every tool
  app.use('/mcp', async (c, next) => {
    const caller = callerOf(c)
    if (caller?.pack && !(await services.principals.ended(caller))) await services.principals.require(caller)
    await next()
  })
  // Per caller: runs reach paid and rate-limited upstreams, so a runaway agent stops here first
  const runs = rateLimit({ policy: 'tool-calls', limit: 300, windowSeconds: 60, store: await dbGuardStore(db) })
  app.on('POST', ['/api/calls', '/api/tools/:name/calls', '/u/:upstream/mcp'], runs)
  // Six builds an hour per pack and caller, refused ones too: each may spend $1 and run real read calls
  const builds = await dbGuardStore(db)
  app.on('POST', '/api/packs/:name/builds', async (c, next) => {
    // Only the owner outside a pack is counted: anyone else gets the handler's 403 alike for every name, so the limit
    // never tells a key which packs exist
    const caller = callerOf(c)
    if (!isOwner(caller) || caller?.pack) return next()
    // By the pack's id, so a rename doesn't give it six more; a name no pack has is the handler's 404, never a policy
    const pack = await services.packs.get(c.req.param('name') ?? '')
    if (!pack) return next()
    return rateLimit({ policy: `builds for ${pack.id}`, limit: 6, windowSeconds: 3600, store: builds })(c, next)
  })
  // Ten tries a minute per address: owner keys are long, but a guess should still be slow
  app.on(
    'POST',
    ['/api/session', '/api/session/claim'],
    rateLimit({ policy: 'sign-in', limit: 10, windowSeconds: 60, store: await dbGuardStore(db) }),
  )
  // The caller's W3C trace context (a `traceparent` header; MCP's `_meta.traceparent` arrives as one): calls join it
  app.use('/api/*', (c, next) => traceContext.run(parseTraceparent(c.req.header('traceparent')), next))
  for (const feature of features) feature.register(app, services)
  serveGuide(app, { files: GUIDE_FILES, vars: () => GUIDE_VARS, full: ['llms.txt'] })
  // Each pack's own guide, OpenAPI document and docs page, at its address
  mountPackDocs(app, services)
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
  // Outermost: a pack's address is rewritten before anything reads it, and its answers link only inside it.
  // Innermost: a playbook's arguments as query parameters are lifted off before the kit refuses them
  app.fetch = withPackAddresses(sessionAuth.wrap(withPlaybookQuery(app.fetch) as never) as typeof app.fetch)
  // Around everything, until 0.7.0: what each app sends as it signs in, measured before OAuth's rules are settled
  if (oauthStore) app.fetch = signInLog({ store: oauthStore })(app.fetch as never) as typeof app.fetch
  return Object.assign(app, { services })
}
