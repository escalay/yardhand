/**
 * `GET /u/{upstream}/r/<path>`: a read-only window onto an upstream's own host (images, files, linked records), fetched
 * with the gateway's stored credential. Results have their links rewritten to point here, so any link a tool returns
 * opens with the caller's gateway key.
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { proxiedPath } from '../features/calls/handed.js'
import { rewriteLinks } from '../features/calls/links.js'
import { allows, callerOf } from '../features/clients/principals.js'
import { originOf, ProblemError, problemResponse } from '../kit/index.js'
import type { Services } from '../services.js'

// Never content-length or content-encoding: fetch hands over the body decoded, so the upstream's sizes no longer hold
const PASS_HEADERS = ['content-type', 'cache-control', 'etag', 'last-modified', 'content-disposition']
const TEXTUAL = /json|text\/|xml|javascript/

export const mountProxy = (app: OpenAPIHono, { principals, upstreams, upstreamHeaders, handed }: Services) => {
  app.get('/u/:upstream/r/*', async (c: Context) => {
    const principal = await principals.require(callerOf(c)).catch((problem: ProblemError) => problem)
    if (principal instanceof ProblemError) return problemResponse(c, 'forbidden', { detail: principal.message })
    const id = c.req.param('upstream') ?? ''
    const upstream = await upstreams.get(id)
    if (upstream?.enabled && allows(principal, id) && !upstream.linkProxy)
      return problemResponse(c, 'forbidden', {
        detail: `Links to ${id}'s host don't open through the gateway: the owner switched that off for ${id}.`,
      })
    if (!upstream?.enabled || !allows(principal, id))
      return problemResponse(c, 'not_found', {
        detail: `No upstream ${id} for this client. GET /api/upstreams lists yours.`,
      })
    const prefix = `/u/${id}/r/`
    const incoming = new URL(c.req.url)
    // A key locked to a pack opens the links its tools returned, not the rest of the upstream's host
    if (!(await handed.opensPath(principal, id, proxiedPath(incoming, id))))
      return problemResponse(c, 'forbidden', {
        detail: `This link was not in a result of ${principal.pack?.title ?? 'the pack'}'s tools in the last day: a key locked to a pack opens only the links its tools returned.`,
      })
    const origin = new URL(upstream.url).origin
    // The path stays a path on the upstream's own host: `//other.host/…` would otherwise resolve to another host
    // and carry the upstream's credential there
    const path = incoming.pathname.slice(prefix.length).replace(/^\/+/, '')
    let target = new URL(path + incoming.search, `${origin}/`)
    if (target.origin !== origin)
      return problemResponse(c, 'bad_request', { detail: 'Only paths on the upstream’s own host.' })
    const direct = target.href
    const accept = c.req.header('accept') ?? '*/*'
    const headers = { accept, ...(await upstreamHeaders(upstream)) }
    let response: Response | null = null
    // Redirects are followed by hand, and only on the same host, so the credential never leaves it
    for (let hop = 0; hop < 4; hop++) {
      response = await fetch(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) }).catch(
        () => null,
      )
      const location =
        response && response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
      if (!location) break
      const next = new URL(location, target)
      // A sign-in wall in front of the upstream (Cloudflare Access): a browser opens the link itself, with its own session
      if (next.origin !== origin)
        return accept.includes('text/html')
          ? c.redirect(direct, 302)
          : problemResponse(c, 'bad_request', {
              detail: `${id} redirected to another host (${next.host}); open ${direct} directly.`,
            })
      target = next
    }
    if (!response) return problemResponse(c, 'upstream', { detail: `${id} did not answer for ${target.pathname}.` })
    const out = new Headers()
    for (const name of PASS_HEADERS) {
      const value = response.headers.get(name)
      if (value) out.set(name, value)
    }
    // Records link onwards to the same host: rewrite those too, so every link keeps opening through here
    if (TEXTUAL.test(response.headers.get('content-type') ?? '')) {
      const text = await response.text()
      const rewritten = rewriteLinks(text, { upstreamUrl: upstream.url, upstreamId: id, gatewayOrigin: originOf(c) })
      await handed.note(principal, id, rewritten, originOf(c))
      out.delete('etag')
      return new Response(rewritten, { status: response.status, headers: out })
    }
    return new Response(response.body, { status: response.status, headers: out })
  })
}
