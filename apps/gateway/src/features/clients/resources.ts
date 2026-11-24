/**
 * What a sign-in is for (RFC 8707): the one reader of a resource's path. The root (`<origin>`, `<origin>/mcp`, and the
 * legacy `<origin>/mcp/p/<pack>`) is the whole gateway; `<origin>/p/<pack>/mcp` is that pack, its REST under
 * `/p/<pack>/api` included. Anything else is no resource here. The kit checks the origin, so only the path is read.
 */
import type { Context } from 'hono'
import type { TokenCaller } from '../../kit/index.js'
import type { PacksRepo } from '../packs/repo.js'
import { askedByAddress, NAME, packBaseOf } from './pack-choice.js'
import { UNKNOWN_SIGN_IN } from './principals.js'
import type { ClientsRepo } from './repo.js'

export type ResourceClass = { kind: 'root' } | { kind: 'pack'; name: string } | null

const ROOT = new RegExp(`^(/mcp(/p/${NAME})?)?$`)
const PACK = new RegExp(`^/p/(${NAME})/mcp$`)

/** What a resource's path names, matched whole: the root, one pack, or nothing. */
export const classOf = (path: string): ResourceClass => {
  if (ROOT.test(path)) return { kind: 'root' }
  const name = PACK.exec(path)?.[1]
  return name ? { kind: 'pack', name } : null
}

/** A resource's path, or null for one not written plainly (another scheme, a user part, a query, dot segments). */
const pathOf = (resource: string) => {
  if (!URL.canParse(resource) || /[?#]|%2e/i.test(resource)) return null
  const url = new URL(resource)
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null
  const path = resource.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/i, '')
  return path === url.pathname || (!path && url.pathname === '/') ? path : null
}

/** What a whole resource URL names: a token's `aud`, a grant's resource. */
export const classOfResource = (resource: string) => {
  const path = pathOf(resource)
  return path === null ? null : classOf(path)
}

/** The kit's `resources`: whether the gateway issues for a path. No lookup, so asking tells a stranger nothing. */
export const issuesFor = (path: string) => classOf(path) !== null

/** The resource a request is for, where its 401 points: a pack's address is that pack's MCP, else the kit's default. */
export const resourceOf = (rootOf: (c: Context) => string) => (c: Context) => {
  const base = packBaseOf()
  if (base) return `${rootOf(c)}${base}/mcp`
  return `${rootOf(c)}${c.req.path === '/mcp' || c.req.path.startsWith('/mcp/') ? '/mcp' : ''}`
}

/**
 * The kit's `accepts`. A root or aud-less token is taken everywhere: the owner approved it, and the principal decides
 * what it reaches. A pack's token only at that pack's own address, judged by its row's pack, never by the name in its
 * `aud`; the refusal names the row's pack as it is now, so a name freed and taken again tells no one the other pack.
 */
export const accepts =
  ({ clients, packs }: { clients: ClientsRepo; packs: PacksRepo }, rootOf: (c: Context) => string) =>
  async (caller: TokenCaller, c: Context): Promise<true | string> => {
    const resource = caller.resource === undefined ? { kind: 'root' as const } : classOfResource(caller.resource)
    if (resource?.kind === 'root') return true
    const row = resource && caller.grant ? await clients.byGrant(caller.grant) : undefined
    const home = row && (row.packId ?? (await clients.packsOf(row))[0])
    const pack = home && (await packs.byId(home))
    if (!pack) return UNKNOWN_SIGN_IN
    const asked = askedByAddress() ? await packs.holderOf(packBaseOf().slice('/p/'.length)) : undefined
    if (asked?.pack.id === pack.id) return true
    return `This sign-in opens ${pack.title} only: connect at ${rootOf(c)}/p/${pack.name}/mcp.`
  }
