/**
 * Every feature of the gateway, one folder each:
 *   schema.ts    Drizzle tables + the SQL migration steps
 *   repo.ts      the only file with queries
 *   routes.ts    OpenAPI contracts (createRoute)
 *   handlers.ts  request → services → HAL answer, errors as problems
 *   index.ts     the feature: its migrations and routes
 * The gateway's MCP tools live in `src/mcp/`, over these routes.
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { McpTool } from '../kit/mcp/index.js'
import type { Services } from '../services.js'
import { feature as ai } from './ai/index.js'
import { feature as backups } from './backups/index.js'
import { feature as calls } from './calls/index.js'
import { feature as catalog } from './catalog/index.js'
import { feature as clients } from './clients/index.js'
import { feature as config } from './config/index.js'
import { feature as connections } from './connections/index.js'
import { feature as events } from './events/index.js'
import { feature as groups } from './groups/index.js'
import { feature as home } from './home/index.js'
import { feature as overview } from './overview/index.js'
import { feature as packs } from './packs/index.js'
import { feature as searches } from './searches/index.js'
import { feature as tools } from './tools/index.js'
import { feature as upstreams } from './upstreams/index.js'
import { feature as vault } from './vault/index.js'

export type Feature = {
  name: string
  /** The OpenAPI tag its routes carry. */
  tag: { name: string; description: string }
  /** Its tables as SQL steps, in order; run before any feature registers. */
  migrations: readonly string[]
  /** Registers its routes. */
  register: (app: OpenAPIHono, services: Services) => void
  tools: McpTool[]
}

export const FEATURES: Feature[] = [
  home,
  vault,
  clients,
  upstreams,
  connections,
  tools,
  groups,
  ai,
  catalog,
  packs,
  calls,
  events,
  searches,
  overview,
  config,
  backups,
]
