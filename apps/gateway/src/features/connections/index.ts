/**
 * Connections: OAuth upstreams the owner connects once. `POST /api/upstreams/{id}/connect` starts it (discovery,
 * client registration, PKCE) and answers the URL to approve at; the upstream sends the owner back to
 * `/app/connect/callback`, behind Access, where the code becomes tokens and the upstream syncs.
 */
import { createRoute, z } from '@hono/zod-openapi'
import { auth } from '@modelcontextprotocol/client'
import type { Context } from 'hono'
import { HAL_JSON, LinksSchema, linksOf, originOf, ProblemError, problemResponses } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { callerOf, isOwner, requireOwner } from '../clients/principals.js'
import type { Feature } from '../index.js'
import { callbackPath, expectedState } from './provider.js'

const TAG = 'Upstreams'
const ConnectSchema = z
  .object({
    upstream: z.string(),
    connected: z.boolean().openapi({ description: 'True when stored tokens already work; nothing to approve.' }),
    authorizeUrl: z
      .string()
      .nullable()
      .openapi({ description: 'Open it, sign in to the upstream and approve; it sends you back here.' }),
    _links: LinksSchema,
  })
  .openapi('Connect', { description: 'Where an OAuth upstream stands, and where to approve it.' })

const connectRoute = createRoute({
  method: 'post',
  path: '/api/upstreams/{id}/connect',
  operationId: 'connectUpstream',
  tags: [TAG],
  summary: 'Connect an OAuth upstream',
  description:
    'Starts (or refreshes) the OAuth connection of an upstream with `auth: oauth` (owner only). Answers `authorizeUrl` to open in a browser; after approving, the upstream syncs on its own.',
  request: { params: z.object({ id: z.string().min(1).max(40).openapi({ description: 'The upstream id.' }) }) },
  responses: {
    200: { content: { [HAL_JSON]: { schema: ConnectSchema } }, description: 'The connection.' },
    ...problemResponses(400, 401, 403, 404, 503),
  },
})

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p></body>`
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const feature: Feature = {
  name: 'connections',
  tag: { name: 'Connections', description: 'OAuth upstreams, connected once by the owner.' },
  migrations: [],
  register: (app, services: Services) => {
    const { upstreams, oauthProviderFor, adapters, sync, vault } = services
    const oauthUpstream = async (id: string) => {
      const row = await upstreams.get(id)
      if (!row) throw new ProblemError('not_found', { detail: `No upstream ${id}. GET /api/upstreams lists them.` })
      if (row.kind !== 'mcp' || row.auth !== 'oauth')
        throw new ProblemError('bad_request', {
          detail: `${id} doesn't use OAuth: PATCH it with auth {"type": "oauth"} first.`,
        })
      return row
    }

    app.openapi(connectRoute, async (c) => {
      requireOwner(c)
      const row = await oauthUpstream(c.req.valid('param').id)
      let authorizeUrl: string | null = null
      const provider = oauthProviderFor(row.id, (url) => {
        authorizeUrl = url.toString()
      })
      const result = await auth(provider, { serverUrl: row.url }).catch((error: unknown) => {
        throw new ProblemError('upstream', { detail: `${row.id}: could not start OAuth (${message(error)}).` })
      })
      if (result === 'AUTHORIZED') {
        await adapters.forget(row.id)
        await sync(row.id).catch(() => null)
      }
      return c.json(
        {
          upstream: row.id,
          connected: result === 'AUTHORIZED',
          authorizeUrl,
          _links: linksOf(originOf(c), {
            self: `/api/upstreams/${row.id}/connect`,
            upstream: `/api/upstreams/${row.id}`,
          }),
        },
        200,
      )
    })

    // The browser lands here from the upstream's consent page; Access signs the owner in on the way
    app.get(callbackPath, async (c: Context) => {
      if (!isOwner(callerOf(c)))
        return c.html(page('Sign in first', 'Connecting an upstream needs you signed in as the owner.'), 403)
      const { code, state, iss, error, error_description: why } = c.req.query()
      const upstreamId = state?.split('.')[0] ?? ''
      if (error)
        return c.html(page('Not connected', `${escapeHtml(upstreamId)} said: ${escapeHtml(why ?? error)}`), 400)
      if (!code || !state || state !== (await expectedState(vault, upstreamId)))
        return c.html(
          page(
            'Expired',
            'This approval doesn’t match the last connect. Start again with POST /api/upstreams/{id}/connect.',
          ),
          400,
        )
      try {
        const row = await oauthUpstream(upstreamId)
        const result = await auth(oauthProviderFor(row.id), {
          serverUrl: row.url,
          authorizationCode: code,
          ...(iss ? { iss } : {}),
        })
        if (result !== 'AUTHORIZED')
          return c.html(page('Not connected', `${escapeHtml(row.id)} asked for another approval; start again.`), 400)
        await adapters.forget(row.id)
        const summary = await sync(row.id)
        return c.html(
          page(
            `${escapeHtml(row.id)} connected`,
            `${summary.added.length + summary.changed.length} tools are live (or waiting for review). You can close this tab.`,
          ),
        )
      } catch (failure) {
        return c.html(page('Not connected', escapeHtml(message(failure))), 502)
      }
    })
  },
  tools: [],
}
