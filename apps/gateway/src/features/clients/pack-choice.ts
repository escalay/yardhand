/**
 * Which pack a request asks for. Every pack has one address, `/p/<pack>/`: MCP at `/p/<pack>/mcp`, REST under
 * `/p/<pack>/api`, its guide, OpenAPI document and docs page beside them. The older ways still work: `/mcp/p/<pack>`,
 * and `/mcp` or REST naming a pack with the `x-gateway-pack` header. Plain `/mcp` and REST without the header get the
 * key's default pack.
 *
 * MCP and REST addresses are rewritten to `/mcp` and `/api` before anything else sees them, so sign-in, rate limits,
 * MCP and list-change notices work as at the root, and the choice rides along every in-process call the request makes.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { MiddlewareHandler } from 'hono'
import { tryDecodeURI } from 'hono/utils/url'
import { originOf } from '../../kit/index.js'

export const PACK_HEADER = 'x-gateway-pack'
const NAME = '[a-z0-9][a-z0-9-]{0,39}'
const ADDRESS = new RegExp(`^/p/(${NAME})(/.*)?$`)
const LEGACY_ADDRESS = new RegExp(`^/mcp/p/(${NAME})(/.*)?$`)

/** The pack an address chose; `base` is `/p/<name>` when the request came by the pack's own address, else null. */
type Choice = { name: string; base: string | null }
const chosen = new AsyncLocalStorage<Choice>()

type Fetch = (request: Request, ...rest: never[]) => Response | Promise<Response>

/** A path as the router reads it, percent-encoded letters decoded: what is served is decided on this one. */
const routed = (path: string) => tryDecodeURI(path.includes('%25') ? path.replace(/%25/g, '%2525') : path)
const API = /^\/api(\/|$)/
/** Health and sign-in belong to the gateway, not to a pack. */
const AT_ROOT_ONLY = /^\/api\/(health|session)(\/|$)/
/**
 * Served under a pack's address as they are at the root: MCP itself and the API. Nothing beside `/mcp`: the public
 * server card there is the gateway's.
 */
const rewritten = (path: string) => path === '/mcp' || (API.test(path) && !AT_ROOT_ONLY.test(path))
/** Served under a pack's address by the pack's own routes: its front page, guide, OpenAPI document and docs. */
const KEPT = new Set(['', '/', '/llms.txt', '/openapi.json', '/docs'])

/** Does a pack's address serve this root path? The one list `withPackAddresses` serves and `packLinks` relinks by. */
export const insidePack = (path: string) => rewritten(path) || KEPT.has(path)

/** The same request at another address, field by field: the server's own Request can't be handed over whole. */
const readdressed = (request: Request, url: URL): Request =>
  new Request(url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    duplex: 'half',
  } as RequestInit)

/** Without the kit's `link` header: it points at the gateway's own documents, not the pack's. */
const withoutRootPointers = (response: Response) => {
  if (!response.headers.has('link')) return response
  const headers = new Headers(response.headers)
  headers.delete('link')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * Wraps the app's fetch. `/p/<pack>/mcp` and `/p/<pack>/api…` are served as `/mcp` and `/api…` with that pack
 * chosen; the pack's own pages keep their path and run with it chosen; anything else under `/p/<pack>/` passes
 * through as it is and finds no route. `/mcp/p/<pack>[/…]` is served as `/mcp[/…]`.
 */
export const withPackAddresses = <F extends Fetch>(fetch: F): F =>
  (async (request: Request, ...rest: never[]) => {
    const url = new URL(request.url)
    const legacy = LEGACY_ADDRESS.exec(url.pathname)
    if (legacy?.[1]) {
      url.pathname = `/mcp${legacy[2] ?? ''}`
      return chosen.run({ name: legacy[1], base: null }, () => fetch(readdressed(request, url), ...rest))
    }
    const match = ADDRESS.exec(url.pathname)
    if (!match?.[1]) return fetch(request, ...rest)
    const choice = { name: match[1], base: `/p/${match[1]}` }
    const path = match[2] ?? ''
    const seen = routed(path)
    if (rewritten(seen)) {
      url.pathname = path
      return withoutRootPointers(await chosen.run(choice, () => fetch(readdressed(request, url), ...rest)))
    }
    return withoutRootPointers(
      await (KEPT.has(seen) ? chosen.run(choice, () => fetch(request, ...rest)) : fetch(request, ...rest)),
    )
  }) as F

/** `/p/<pack>` when this request came by a pack's own address, else nothing: for addresses printed outside `_links`. */
export const packBaseOf = () => chosen.getStore()?.base ?? ''

type Linked = { _links?: Record<string, { href?: unknown }>; _embedded?: Record<string, unknown> }

/** Moves the links the pack's address serves under it; a link to anywhere else stays as it is. */
const relink = (resource: Linked, origin: string, base: string) => {
  for (const link of Object.values(resource._links ?? {})) {
    if (typeof link?.href !== 'string' || !link.href.startsWith(origin)) continue
    const path = link.href.slice(origin.length)
    // Without its query or template: `/api/tools?upstream=x`, `/api/tools{?as}`
    if (insidePack(path.split(/[?#{]/)[0] ?? '')) link.href = `${origin}${base}${path}`
  }
}

/**
 * Keeps the links of an answer inside the pack's address when the request came by it: HAL's own `_links`, on the
 * answer and on what it embeds, never anything inside a tool's result. The link proxy (`/u/<upstream>/r/…`) is not
 * under a pack's address, so links in results keep theirs.
 */
export const packLinks: MiddlewareHandler = async (c, next) => {
  await next()
  const base = chosen.getStore()?.base
  const type = c.res.headers.get('content-type') ?? ''
  if (!base || c.res.status < 200 || c.res.status >= 300 || !/^application\/(hal\+)?json/.test(type)) return
  const text = await c.res.text()
  const { status, headers: sent } = c.res
  const headers = new Headers(sent)
  headers.delete('content-length')
  const relinked = (() => {
    try {
      const body = JSON.parse(text) as Linked
      const origin = originOf(c)
      relink(body, origin, base)
      for (const items of Object.values(body._embedded ?? {}))
        for (const item of Array.isArray(items) ? items : [items])
          if (item && typeof item === 'object') relink(item as Linked, origin, base)
      return JSON.stringify(body)
    } catch {
      return text
    }
  })()
  // Cleared first: assigning over a response copies its headers onto the new one
  c.res = undefined
  c.res = new Response(relinked, { status, headers })
}

/**
 * Puts the chosen pack (address or header) on the caller, after authentication, for the principal to honour. A pack
 * named by the header is carried from here on like one an address chose, so the calls MCP makes in-process, which
 * take only the caller's credentials along, are for that pack too.
 */
export const packChoice: MiddlewareHandler = async (c, next) => {
  const stored = chosen.getStore()?.name
  const pack = stored ?? c.req.header(PACK_HEADER)
  const caller = c.get('caller' as never) as object | undefined
  if (pack && caller) c.set('caller' as never, { ...caller, pack } as never)
  if (pack && !stored) await chosen.run({ name: pack, base: null }, next)
  else await next()
}
