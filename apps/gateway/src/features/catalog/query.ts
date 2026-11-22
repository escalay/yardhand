/**
 * A playbook's arguments as their own query parameters: `GET /api/playbooks/{name}/messages?topic=tides`. Which names
 * a playbook takes is known only once it is found for the caller, so every parameter but `arguments` is lifted off
 * the request before the kit refuses names its route doesn't declare, and `reads.playbook` holds them to the
 * playbook's own arguments instead.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const MESSAGES = /^\/api\/playbooks\/[^/]+\/messages$/
const lifted = new AsyncLocalStorage<Map<string, string[]>>()

type Fetch = (request: Request, ...rest: never[]) => Response | Promise<Response>

/** Wraps the app's fetch, inside `withPackAddresses`, so a pack's address is already `/api…` here. */
export const withPlaybookQuery = <F extends Fetch>(fetch: F): F =>
  (async (request: Request, ...rest: never[]) => {
    const url = new URL(request.url)
    if (request.method !== 'GET' || !MESSAGES.test(url.pathname)) return fetch(request, ...rest)
    const given = new Map<string, string[]>()
    for (const name of new Set(url.searchParams.keys()))
      if (name !== 'arguments') given.set(name, url.searchParams.getAll(name))
    for (const name of given.keys()) url.searchParams.delete(name)
    const readdressed = given.size
      ? new Request(url, { method: request.method, headers: request.headers, signal: request.signal })
      : request
    return lifted.run(given, () => fetch(readdressed, ...rest))
  }) as F

/** The query parameters this request gave besides `arguments`, each with every value it was given. */
export const queryArgumentsOf = () => lifted.getStore() ?? new Map<string, string[]>()
