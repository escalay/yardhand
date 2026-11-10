/**
 * The gateway's API, typed from its own OpenAPI document (`pnpm api-types` regenerates `schema.d.ts`). Same origin:
 * behind Cloudflare Access the Access cookie signs every call in, elsewhere the session cookie from the sign-in page.
 * Every call says it comes from the app (`x-gateway-via: app`), so the owner trying things stays apart from agents.
 *
 * @example
 * const upstreams = await unwrap(api.GET('/api/upstreams'))
 */
import createClient from 'openapi-fetch'
import type { components, paths } from './schema'

export const api = createClient<paths>({ baseUrl: '', headers: { 'x-gateway-via': 'app' } })

export type Schemas = components['schemas']
export type Upstream = Schemas['Upstream']
export type Probe = Schemas['Probe']
export type ToolCard = Schemas['ToolCard']
export type ToolDetail = Schemas['ToolDetail']
export type Client = Schemas['Client']
export type CallRecord = Schemas['CallRecord']
export type Overview = Schemas['Overview']
export type Review = Schemas['Review']
export type Surface = Schemas['SetupSurface']
export type Playbook = Schemas['Playbook']
export type UpstreamLink = Schemas['UpstreamLink']
export type Pack = Schemas['Pack']

/** A problem answer (RFC 9457) as an Error: `detail` is what to show, `errors` which fields. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors: { path: string; message: string }[] = [],
  ) {
    super(message)
  }
}

/** The answer's data, or an ApiError carrying the problem's `detail`. */
export const unwrap = async <Data>(request: Promise<{ data?: Data; error?: unknown; response: Response }>) => {
  const { data, error, response } = await request
  if (response.status === 204) return data as Data
  if (data === undefined || !response.ok) {
    const problem = error as
      | { detail?: string; title?: string; errors?: { path: string; message: string }[] }
      | undefined
    throw new ApiError(
      response.status,
      problem?.detail ?? problem?.title ?? `${response.status} ${response.statusText}`,
      problem?.errors ?? [],
    )
  }
  return data
}

/** An absolute link from the API as a same-origin path. */
export const local = (href: string | undefined | null) => {
  if (!href) return undefined
  const url = new URL(href, location.origin)
  return `${url.pathname}${url.search}`
}

/** The `cursor` of a page's `_links.next`, or undefined on the last page. */
export const nextCursor = (page: { _links: Record<string, { href: string } | undefined> }) => {
  const next = page._links.next?.href
  return next ? (new URL(next, location.origin).searchParams.get('cursor') ?? undefined) : undefined
}
