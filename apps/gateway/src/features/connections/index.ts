/**
 * Connections: OAuth upstreams the owner connects once. `POST /api/upstreams/{id}/connect` starts it (discovery,
 * client registration, PKCE) and answers the URL to approve at; the upstream sends the owner back to
 * `/app/connect/callback`, behind Access, where the code becomes tokens and the upstream syncs. A server that refuses
 * that callback is connected `via: loopback`: the approval ends on an address on the owner's computer that never
 * loads, and the owner pastes it into `POST /api/upstreams/{id}/connect/complete`.
 */
import { createRoute, z } from '@hono/zod-openapi'
import { auth } from '@modelcontextprotocol/client'
import type { Context } from 'hono'
import { HAL_JSON, LinksSchema, linksOf, originOf, ProblemError, problemResponses } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { callerOf, isOwner, requireOwner } from '../clients/principals.js'
import type { Feature } from '../index.js'
import { callbackPath, chooseSignInVia, expectedState, forgetState, type SignInVia, signInViaOf } from './provider.js'

const TAG = 'Upstreams'
const ViaSchema = z.enum(['gateway', 'loopback']).openapi({
  description:
    '`gateway`: the upstream sends you back to this gateway. `loopback`: it sends you to `http://localhost:8765/callback`, as it would an app on your computer; that page never loads, and you paste its address into `POST /api/upstreams/{id}/connect/complete`. Use it when the upstream refuses to sign in a web app it doesn’t know.',
})
const ConnectSchema = z
  .object({
    upstream: z.string(),
    connected: z.boolean().openapi({ description: 'True when stored tokens already work; nothing to approve.' }),
    authorizeUrl: z
      .string()
      .nullable()
      .openapi({ description: 'Open it, sign in to the upstream and approve; it sends you back here.' }),
    via: ViaSchema,
    _links: LinksSchema,
  })
  .openapi('Connect', { description: 'Where an OAuth upstream stands, and where to approve it.' })
const CompletedSchema = z
  .object({
    upstream: z.string(),
    connected: z.literal(true),
    tools: z.number().int().openapi({ description: 'Tools added or changed by the sync that followed.' }),
    _links: LinksSchema,
  })
  .openapi('ConnectCompleted', { description: 'An OAuth upstream connected from a pasted sign-in address.' })

const idParam = z.object({ id: z.string().min(1).max(40).openapi({ description: 'The upstream id.' }) })

const connectRoute = createRoute({
  method: 'post',
  path: '/api/upstreams/{id}/connect',
  operationId: 'connectUpstream',
  tags: [TAG],
  summary: 'Connect an OAuth upstream',
  description:
    'Starts (or refreshes) the OAuth connection of an upstream with `auth: oauth` (owner only). Answers `authorizeUrl` to open in a browser; after approving, the upstream syncs on its own. `?via=` chooses how the upstream sends you back; without it the last choice holds.',
  request: { params: idParam, query: z.object({ via: ViaSchema.optional() }) },
  responses: {
    200: { content: { [HAL_JSON]: { schema: ConnectSchema } }, description: 'The connection.' },
    ...problemResponses(400, 401, 403, 404, 503),
  },
})

const completeRoute = createRoute({
  method: 'post',
  path: '/api/upstreams/{id}/connect/complete',
  operationId: 'completeUpstreamConnect',
  tags: [TAG],
  summary: 'Finish a loopback sign-in',
  description:
    'Finishes a connect started `via: loopback` (owner only): send the address the approval ended on (`http://localhost:8765/callback?code=…&state=…`). The code becomes tokens and the upstream syncs.',
  request: {
    params: idParam,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z
            .object({
              url: z.string().min(1).max(4000).openapi({
                description: 'The whole address from the tab, starting `http://localhost:8765/callback?`.',
              }),
            })
            .openapi('CompleteConnectInput', { description: 'The address a loopback approval ended on.' }),
        },
      },
    },
  },
  responses: {
    200: { content: { [HAL_JSON]: { schema: CompletedSchema } }, description: 'Connected and synced.' },
    ...problemResponses(400, 401, 403, 404, 503),
  },
})

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p></body>`
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What came back from an approval, from the callback's query or a pasted address. */
type Returned = { code?: string; state?: string; iss?: string; error?: string; error_description?: string }
type Finished =
  | { ok: true; upstream: string; tools: number }
  | { ok: false; status: 400 | 502; title: string; detail: string }

const returnedOf = (pasted: string): Returned | null => {
  try {
    return Object.fromEntries(new URL(pasted.trim()).searchParams) as Returned
  } catch {
    return null
  }
}

export const feature: Feature = {
  name: 'connections',
  tag: { name: 'Connections', description: 'OAuth upstreams, connected once by the owner.' },
  migrations: [],
  register: (app, services: Services) => {
    const { upstreams, oauthProviderFor, redirectUrlOf, adapters, sync, vault } = services
    const oauthUpstream = async (id: string) => {
      const row = await upstreams.get(id)
      if (!row) throw new ProblemError('not_found', { detail: `No upstream ${id}. GET /api/upstreams lists them.` })
      if (row.kind !== 'mcp' || row.auth !== 'oauth')
        throw new ProblemError('bad_request', {
          detail: `${id} doesn't use OAuth: PATCH it with auth {"type": "oauth"} first.`,
        })
      return row
    }

    /** Turns an approval's code into tokens and syncs; the same for the callback and a pasted address. */
    const finish = async (returned: Returned, upstreamId: string): Promise<Finished> => {
      const { code, state, iss, error, error_description: why } = returned
      if (error)
        return { ok: false, status: 400, title: 'Not connected', detail: `${upstreamId} said: ${why ?? error}` }
      if (!code || !state || state !== (await expectedState(vault, upstreamId)))
        return {
          ok: false,
          status: 400,
          title: 'Expired',
          detail: 'This approval doesn’t match the last connect. Start again with POST /api/upstreams/{id}/connect.',
        }
      try {
        const row = await oauthUpstream(upstreamId)
        const via = await signInViaOf(vault, row.id)
        const result = await auth(oauthProviderFor(row.id, undefined, via), {
          serverUrl: row.url,
          authorizationCode: code,
          ...(iss ? { iss } : {}),
        })
        if (result !== 'AUTHORIZED')
          return {
            ok: false,
            status: 400,
            title: 'Not connected',
            detail: `${row.id} asked for another approval; start again.`,
          }
        await forgetState(vault, row.id)
        await adapters.forget(row.id)
        const summary = await sync(row.id)
        return { ok: true, upstream: row.id, tools: summary.added.length + summary.changed.length }
      } catch (failure) {
        return { ok: false, status: 502, title: 'Not connected', detail: message(failure) }
      }
    }

    app.openapi(connectRoute, async (c) => {
      requireOwner(c)
      const row = await oauthUpstream(c.req.valid('param').id)
      const via: SignInVia = c.req.valid('query').via ?? (await signInViaOf(vault, row.id))
      await chooseSignInVia(vault, row.id, via, redirectUrlOf(via))
      let authorizeUrl: string | null = null
      const provider = oauthProviderFor(
        row.id,
        (url) => {
          authorizeUrl = url.toString()
        },
        via,
      )
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
          via,
          _links: linksOf(originOf(c), {
            self: `/api/upstreams/${row.id}/connect`,
            upstream: `/api/upstreams/${row.id}`,
            ...(via === 'loopback' ? { complete: `/api/upstreams/${row.id}/connect/complete` } : {}),
          }),
        },
        200,
      )
    })

    app.openapi(completeRoute, async (c) => {
      requireOwner(c)
      const row = await oauthUpstream(c.req.valid('param').id)
      const returned = returnedOf(c.req.valid('json').url)
      if (!returned)
        throw new ProblemError('bad_request', {
          detail:
            'That isn’t an address: copy the whole address from the tab, starting http://localhost:8765/callback?',
        })
      if (!returned.code && !returned.error)
        throw new ProblemError('bad_request', {
          detail:
            'That address has no code in it: copy it from the tab the approval ended on, after you allowed access.',
        })
      if (returned.state && !returned.state.startsWith(`${row.id}.`))
        throw new ProblemError('bad_request', {
          detail: `That approval belongs to ${returned.state.split('.')[0]}, not ${row.id}.`,
        })
      const finished = await finish(returned, row.id)
      if (!finished.ok)
        throw new ProblemError(finished.status === 502 ? 'upstream' : 'bad_request', {
          detail: `${finished.title}: ${finished.detail}`,
        })
      return c.json(
        {
          upstream: row.id,
          connected: true as const,
          tools: finished.tools,
          _links: linksOf(originOf(c), { upstream: `/api/upstreams/${row.id}` }),
        },
        200,
      )
    })

    // The browser lands here from the upstream's consent page; Access signs the owner in on the way
    app.get(callbackPath, async (c: Context) => {
      if (!isOwner(callerOf(c)))
        return c.html(page('Sign in first', 'Connecting an upstream needs you signed in as the owner.'), 403)
      const returned = c.req.query() as Returned
      const upstreamId = returned.state?.split('.')[0] ?? ''
      const finished = await finish(returned, upstreamId)
      if (!finished.ok) return c.html(page(finished.title, escapeHtml(finished.detail)), finished.status)
      return c.html(
        page(
          `${escapeHtml(finished.upstream)} connected`,
          `${finished.tools} tools are live (or waiting for review). You can close this tab.`,
        ),
      )
    })
  },
  tools: [],
}
