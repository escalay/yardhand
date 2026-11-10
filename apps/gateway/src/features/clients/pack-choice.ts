/**
 * Which pack a request asks for. A key can open several packs, each at its own address, `/mcp/p/<pack>`, so a client
 * lists each as a server of its own; REST names one with the `x-gateway-pack` header. Plain `/mcp` and REST without
 * the header get the key's default pack.
 *
 * The address is rewritten to `/mcp` before anything else sees it, so sign-in, MCP and list-change notices work as on
 * `/mcp`, and the choice rides along every in-process call the request makes.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { MiddlewareHandler } from 'hono'

export const PACK_HEADER = 'x-gateway-pack'
const PACK_ADDRESS = /^\/mcp\/p\/([a-z0-9][a-z0-9-]{0,39})(\/.*)?$/

const chosen = new AsyncLocalStorage<string>()

type Fetch = (request: Request, ...rest: never[]) => Response | Promise<Response>

/** The same request at another address, field by field: the server's own Request can't be handed over whole. */
const readdressed = (request: Request, url: URL): Request =>
  new Request(url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    duplex: 'half',
  } as RequestInit)

/** Wraps the app's fetch: `/mcp/p/<pack>[/…]` is served as `/mcp[/…]` with that pack chosen. */
export const withPackAddresses = <F extends Fetch>(fetch: F): F =>
  ((request: Request, ...rest: never[]) => {
    const url = new URL(request.url)
    const match = PACK_ADDRESS.exec(url.pathname)
    if (!match?.[1]) return fetch(request, ...rest)
    url.pathname = `/mcp${match[2] ?? ''}`
    return chosen.run(match[1], () => fetch(readdressed(request, url), ...rest))
  }) as F

/** Puts the chosen pack (address or header) on the caller, after authentication, for the principal to honour. */
export const packChoice: MiddlewareHandler = async (c, next) => {
  const pack = chosen.getStore() ?? c.req.header(PACK_HEADER)
  const caller = c.get('caller' as never) as object | undefined
  if (pack && caller) c.set('caller' as never, { ...caller, pack } as never)
  await next()
}
