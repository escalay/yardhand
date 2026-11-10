/**
 * Signing the owner in to /app with an owner key, for deployments without Cloudflare Access in front (the single
 * compose file, local dev). The key is checked once and traded for an HttpOnly, SameSite=Strict cookie; the browser
 * never keeps the key. `sessionAuth` turns that cookie back into the owner on each request, before the kit's auth.
 * Behind Access the owner never needs this: the Access cookie already signs them in.
 */
import { randomBytes } from 'node:crypto'
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import {
  HAL_JSON,
  hashApiKey,
  LinksSchema,
  linksOf,
  mintApiKey,
  originOf,
  ProblemError,
  problemResponses,
} from '../../kit/index.js'
import type { Feature } from '../index.js'
import { SESSION_DAYS, type SessionsRepo } from './repo.js'
import { SESSIONS_MIGRATIONS } from './schema.js'

export const PATH = '/api/session'
export const COOKIE = 'gw_session'
const TAG = 'Session'
/** The name the session's stand-in key carries in the kit's key map: an owner name, never a client's. */
const SESSION_KEY_NAME = 'owner:session'
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

const SessionSchema = z
  .object({
    signedIn: z.boolean(),
    via: z
      .enum(['access', 'session', 'key'])
      .nullable()
      .openapi({ description: 'How this request is signed in: Cloudflare Access, a session cookie or a key.' }),
    methods: z.array(z.enum(['access', 'key'])).openapi({
      description: 'How the owner can sign in here: `access` (Cloudflare Access) and `key` (an owner key).',
    }),
    setup: z.boolean().openapi({
      description: 'Nobody owns this instance yet: claim it with the setup code the server printed in its log.',
    }),
    _links: LinksSchema,
  })
  .openapi('Session', { description: 'Whether this browser is signed in, and how it can be.' })
const SignInSchema = z
  .object({ key: z.string().min(8).max(500).openapi({ description: 'An owner key (from API_KEYS).' }) })
  .openapi('SignIn', { description: 'An owner key, traded for a session cookie.' })

const ClaimSchema = z
  .object({
    code: z
      .string()
      .min(8)
      .max(20)
      .openapi({ description: 'The setup code from the server’s log, e.g. 7F3K-92QD.', example: '7F3K-92QD' }),
  })
  .openapi('Claim', { description: 'The setup code that proves you run this instance.' })
const ClaimedSchema = z
  .object({
    key: z.string().openapi({ description: 'The owner key. Shown this once: the instance keeps only its hash.' }),
    _links: LinksSchema,
  })
  .openapi('Claimed', { description: 'The instance is yours: its owner key, and this browser is signed in.' })

const routes = {
  claim: createRoute({
    method: 'post',
    path: `${PATH}/claim`,
    operationId: 'claimInstance',
    tags: [TAG],
    summary: 'Claim a new instance',
    description:
      'Makes the caller the owner of an instance nobody owns yet, given the setup code the server printed in its log. Answers the owner key once, keeps only its hash and signs this browser in. Works once; ten tries a minute.',
    request: { body: { required: true, content: { 'application/json': { schema: ClaimSchema } } } },
    responses: {
      200: { content: { [HAL_JSON]: { schema: ClaimedSchema } }, description: 'Claimed.' },
      ...problemResponses(400, 401, 403, 409, 429),
    },
  }),
  get: createRoute({
    method: 'get',
    path: PATH,
    operationId: 'getSession',
    tags: [TAG],
    summary: 'Am I signed in',
    description: 'Whether this browser is signed in as the owner, and the ways it can sign in here. Open to anyone.',
    responses: {
      200: { content: { [HAL_JSON]: { schema: SessionSchema } }, description: 'The session.' },
      ...problemResponses(429),
    },
  }),
  open: createRoute({
    method: 'post',
    path: PATH,
    operationId: 'signIn',
    tags: [TAG],
    summary: 'Sign in with an owner key',
    description: `Checks an owner key and sets an HttpOnly, SameSite=Strict session cookie for ${SESSION_DAYS} days. Client keys can't sign in. Ten tries a minute.`,
    request: { body: { required: true, content: { 'application/json': { schema: SignInSchema } } } },
    responses: {
      200: { content: { [HAL_JSON]: { schema: SessionSchema } }, description: 'Signed in.' },
      ...problemResponses(400, 401, 429),
    },
  }),
  close: createRoute({
    method: 'delete',
    path: PATH,
    operationId: 'signOut',
    tags: [TAG],
    summary: 'Sign out',
    description: 'Ends this browser’s session and clears its cookie.',
    responses: { 204: { description: 'Signed out.' }, ...problemResponses(429) },
  }),
}

/** Same rule as the kit's Access cookie: a write carried by a cookie must come from this site. */
const sameSite = (c: Context) => {
  const site = c.req.header('sec-fetch-site')
  if (site) return site === 'same-origin'
  const origin = c.req.header('origin')
  return Boolean(origin) && new URL(origin as string).host === new URL(c.req.url).host
}

const secureOf = (c: Context) =>
  new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https'

/**
 * The session layer: a stand-in owner key that only this process knows joins the kit's key map, and a request with
 * a valid session cookie (and no credential of its own) is sent on carrying it. Writes must come from this site.
 */
export const createSessionAuth = ({ keys, sessions }: { keys: Map<string, string>; sessions: SessionsRepo }) => {
  const standIn = randomBytes(32).toString('base64url')
  keys.set(hashApiKey(standIn), SESSION_KEY_NAME)
  return {
    /** Wraps the app's fetch: a cookie becomes the owner, before any route or the kit's auth sees the request. */
    wrap:
      (fetch: (request: Request, ...rest: never[]) => Response | Promise<Response>) =>
      async (request: Request, ...rest: never[]) => {
        const token = /(?:^|;\s*)gw_session=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1]
        if (!token || request.headers.has('authorization') || !(await sessions.valid(token)))
          return fetch(request, ...rest)
        const site = request.headers.get('sec-fetch-site')
        const origin = request.headers.get('origin')
        const fromHere = site
          ? site === 'same-origin'
          : Boolean(origin) && new URL(origin as string).host === new URL(request.url).host
        if (!SAFE.has(request.method) && !fromHere) return fetch(request, ...rest)
        const headers = new Headers(request.headers)
        headers.set('authorization', `Bearer ${standIn}`)
        headers.set('x-gateway-session', '1')
        return fetch(new Request(request, { headers }), ...rest)
      },
  }
}

/** An instance nobody owns yet: the code that claims it, and how the owner is recorded. */
export type Unclaimed = { code: string; claim: (ownerHash: string) => void | Promise<void> }

export const sessionFeature = ({
  keys,
  sessions,
  access,
  unclaimed,
}: {
  keys: Map<string, string>
  sessions: SessionsRepo
  access: boolean
  /** Set while the instance waits for its owner; cleared by the claim. */
  unclaimed?: { current: Unclaimed | null }
}): Feature => ({
  name: 'session',
  tag: { name: TAG, description: 'Signing the owner in to /app with a key, where Cloudflare Access is not in front.' },
  migrations: SESSIONS_MIGRATIONS,
  register: (app: OpenAPIHono) => {
    const methods = [...(access ? (['access'] as const) : []), 'key' as const]
    const answer = (c: Context, signedIn: boolean, via: 'access' | 'session' | 'key' | null) =>
      c.json(
        {
          signedIn,
          via,
          methods,
          setup: Boolean(unclaimed?.current),
          _links: linksOf(originOf(c), { self: PATH, app: '/app', me: '/api/me' }),
        },
        200,
      )
    const openSession = async (c: Context) => {
      const token = await sessions.open(c.req.header('user-agent') ?? null)
      setCookie(c, COOKIE, token, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: secureOf(c),
        path: '/',
        maxAge: SESSION_DAYS * 24 * 60 * 60,
      })
    }
    app.openapi(routes.claim, (async (c: Context) => {
      if (!sameSite(c) && c.req.header('origin'))
        throw new ProblemError('forbidden', { detail: 'Claim the instance from its own page.' })
      const waiting = unclaimed?.current
      if (!waiting)
        throw new ProblemError('conflict', {
          detail: 'This instance already has an owner. Sign in with the owner key.',
        })
      const { code } = (await c.req.json().catch(() => ({}))) as { code?: string }
      const typed = (code ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')
      if (!typed || typed !== waiting.code.replace('-', ''))
        throw new ProblemError('unauthorized', {
          detail:
            'That code doesn’t match. Run docker compose logs gateway and copy the code in the box; a restart makes a new one.',
        })
      // Taken before anything awaits, so two tabs racing can't both claim it
      unclaimed.current = null
      const owner = mintApiKey('gw_owner')
      try {
        await waiting.claim(owner.hash)
      } catch (error) {
        unclaimed.current = waiting
        throw error
      }
      keys.set(owner.hash, 'owner')
      await openSession(c)
      c.header('cache-control', 'no-store')
      return c.json({ key: owner.key, _links: linksOf(originOf(c), { self: `${PATH}/claim`, app: '/app/setup' }) }, 200)
    }) as never)
    app.openapi(routes.get, (async (c: Context) => {
      if (c.req.header('x-gateway-session')) return answer(c, true, 'session')
      if (getCookie(c, 'CF_Authorization') || c.req.header('cf-access-jwt-assertion')) return answer(c, true, 'access')
      const key = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1]
      const name = key ? keys.get(hashApiKey(key)) : undefined
      return answer(c, Boolean(name && !name.startsWith('client:')), name ? 'key' : null)
    }) as never)
    app.openapi(routes.open, (async (c: Context) => {
      if (!sameSite(c) && c.req.header('origin'))
        throw new ProblemError('forbidden', { detail: 'Sign in from this site’s own page.' })
      const { key } = (await c.req.json().catch(() => ({}))) as { key?: string }
      const name = key ? keys.get(hashApiKey(key)) : undefined
      if (!name || name.startsWith('client:') || name === SESSION_KEY_NAME)
        throw new ProblemError('unauthorized', {
          detail:
            'That isn’t the owner key. It starts gw_owner_ and was shown once when the instance was set up; a key you gave an agent reaches tools, not this app.',
        })
      await openSession(c)
      return answer(c, true, 'session')
    }) as never)
    app.openapi(routes.close, (async (c: Context) => {
      const token = getCookie(c, COOKIE)
      if (token) await sessions.close(token)
      deleteCookie(c, COOKIE, { path: '/' })
      return c.body(null, 204)
    }) as never)
  },
  tools: [],
})
