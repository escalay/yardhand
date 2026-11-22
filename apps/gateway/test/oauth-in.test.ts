/**
 * Yardhand's own OAuth server end to end, as an app such as claude.ai uses it: it registers, the owner approves in the
 * browser, it trades the code for tokens, calls a tool over MCP and REST, refreshes, and the owner revokes it. The
 * browser keeps every cookie it is given, so an approval that comes to need one more cookie passes unchanged.
 */
import { createHash, randomBytes } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, type Env } from '../src/app.js'
import { generateOAuthKey, hashApiKey, testDb } from '../src/kit/index.js'

const OWNER = 'owner-key-for-oauth'
const REDIRECT = 'http://localhost:9/cb'
const ACCESS = { team: 'example', audience: 'access-audience-tag' }
const ACCESS_CERTS = `https://${ACCESS.team}.cloudflareaccess.com/cdn-cgi/access/certs`

// Cloudflare Access stood in for: its published keys are this test's, and its token one the test signs
const accessKeys = await generateKeyPair('RS256')
const accessJwk = { ...(await exportJWK(accessKeys.publicKey)), kid: 'access', alg: 'RS256', use: 'sig' }
const accessToken = await new SignJWT({ email: 'owner@example.test' })
  .setProtectedHeader({ alg: 'RS256', kid: 'access' })
  .setIssuer(`https://${ACCESS.team}.cloudflareaccess.com`)
  .setAudience(ACCESS.audience)
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(accessKeys.privateKey)
const realFetch = globalThis.fetch
beforeAll(() => {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input) === ACCESS_CERTS
      ? Promise.resolve(Response.json({ keys: [accessJwk] }))
      : realFetch(input, init),
  )
})
afterAll(() => {
  vi.unstubAllGlobals()
})

type App = Awaited<ReturnType<typeof createApp>>

/** A gateway with its OAuth server on and the sample tools connected; each test gets its own. */
const gateway = async (env: Partial<Env> = {}) => {
  const app = await createApp({
    db: await testDb(),
    env: {
      API_KEYS: `owner:${hashApiKey(OWNER)}`,
      GATEWAY_MASTER_KEY: randomBytes(32).toString('base64'),
      OAUTH_SIGNING_KEY: await generateOAuthKey(),
      ...env,
    },
  })
  const made = await app.request('/api/upstreams', {
    method: 'POST',
    headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'sample', kind: 'sample', title: 'Sample tools', auth: { type: 'none' } }),
  })
  expect(made.status).toBe(201)
  return app
}

/** The owner's browser: it sends back every cookie it was given, as a browser does on this site. */
const browserOn = (app: App) => {
  const jar = new Map<string, string>()
  const send = async (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    const response = await app.request(path, {
      method: init.method ?? 'GET',
      headers: { ...(cookie ? { cookie } : {}), ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? ''
      const name = pair.slice(0, pair.indexOf('='))
      const value = pair.slice(pair.indexOf('=') + 1)
      if (!value || /max-age=0/i.test(line)) jar.delete(name)
      else jar.set(name, value)
    }
    return response
  }
  return { send, jar }
}
type Browser = ReturnType<typeof browserOn>

/** An app registering itself, as claude.ai does before it sends the owner to approve it. */
const register = async (app: App, name = 'Sample') => {
  const registered = await app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }),
  })
  expect(registered.status).toBe(201)
  const clientId = ((await registered.json()) as { client_id: string }).client_id
  const verifier = randomBytes(32).toString('base64url')
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'state-from-the-app',
    scope: 'read write',
    resource: 'http://localhost/mcp',
  })
  return { clientId, verifier, authorize: `/oauth/authorize?${query}` }
}

/** The consent page's form as the owner would submit it: every field it carries, and the button that allows. */
const allowFormOf = (html: string) => {
  const form = /<form[^>]*method="post"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html)
  expect(form, 'the consent page has a form').not.toBeNull()
  const fields = new URLSearchParams()
  for (const [input] of (form?.[2] ?? '').matchAll(/<input[^>]*>/g)) {
    const name = /name="([^"]+)"/.exec(input)?.[1]
    const value = /value="([^"]*)"/.exec(input)?.[1]
    if (name && value !== undefined && /type="hidden"/.test(input)) fields.set(name, value)
  }
  const allow = /<button[^>]*name="([^"]+)"[^>]*value="allow"/.exec(form?.[2] ?? '')
  if (allow?.[1]) fields.set(allow[1], 'allow')
  return { action: form?.[1] ?? '', body: fields.toString() }
}

/** The owner opens the consent page and allows it; answers the code the app is sent back with. */
const approve = async (browser: Browser, authorize: string, headers: Record<string, string> = {}) => {
  const consent = await browser.send(authorize, { headers })
  expect(consent.status).toBe(200)
  const { action, body } = allowFormOf(await consent.text())
  const allowed = await browser.send(action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', ...headers },
    body,
  })
  expect(allowed.status).toBe(302)
  const back = new URL(allowed.headers.get('location') ?? '')
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
  expect(back.searchParams.get('state')).toBe('state-from-the-app')
  return back.searchParams.get('code') ?? ''
}

type Tokens = { access_token: string; refresh_token: string; scope: string }
const tokenFor = async (app: App, form: Record<string, string>) => {
  const answer = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  return { status: answer.status, json: (await answer.json()) as Tokens & { error?: string } }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
/** The app's MCP connection, carrying its token, answered by the gateway in-process. */
const mcpWith = async (app: App, token: string) => {
  const client = new Client({ name: 'Sample', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (url, init) => app.request(new Request(url, init)),
    }),
  )
  return client
}
const roll = (app: App, token: string) =>
  app.request('/api/calls', {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ tool: 'sample.roll_dice', arguments: { count: 2, sides: 6 } }),
  })

/** Everything after the approval: tokens, a call each way, a refresh, and the owner revoking it. */
const useAndRevoke = async (app: App, client: { clientId: string; verifier: string }, code: string) => {
  const first = await tokenFor(app, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: client.clientId,
    code_verifier: client.verifier,
    resource: 'http://localhost/mcp',
  })
  expect(first.status).toBe(200)
  expect(first.json.scope).toBe('read write')

  const mcp = await mcpWith(app, first.json.access_token)
  expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain('call_tool')
  const rolled = await mcp.callTool({
    name: 'call_tool',
    arguments: { name: 'sample.roll_dice', arguments: { count: 1, sides: 6 } },
  })
  expect(rolled.isError).toBeFalsy()
  await mcp.close()

  const ran = await roll(app, first.json.access_token)
  expect(ran.status).toBe(200)
  expect(
    ((await ran.json()) as { result: { structuredContent: { rolls: number[] } } }).result.structuredContent.rolls,
  ).toHaveLength(2)

  const refreshed = await tokenFor(app, {
    grant_type: 'refresh_token',
    refresh_token: first.json.refresh_token,
    client_id: client.clientId,
  })
  expect(refreshed.status).toBe(200)
  expect(refreshed.json.refresh_token).not.toBe(first.json.refresh_token)
  expect((await roll(app, refreshed.json.access_token)).status).toBe(200)

  // The app shows as a client of its own, which the owner revokes
  const listedClients = await app.request('/api/clients', { headers: bearer(OWNER) })
  const rows = (
    (await listedClients.json()) as { _embedded: { clients: { id: string; name: string; kind: string }[] } }
  )._embedded.clients
  const row = rows.find((one) => one.kind === 'oauth' && one.name === 'Sample')
  expect(row).toBeDefined()
  expect((await app.request(`/api/clients/${row?.id}`, { method: 'DELETE', headers: bearer(OWNER) })).status).toBe(204)
  const refused = await roll(app, refreshed.json.access_token)
  expect(refused.status).toBe(403)
  expect(((await refused.json()) as { detail: string }).detail).toMatch(/revoked/)
}

describe('an app signing in to the gateway', () => {
  it('signs in with the owner’s approval through Access, calls a tool over MCP and REST, refreshes, and revoke ends it', async () => {
    const app = await gateway({ ACCESS_TEAM: ACCESS.team, ACCESS_AUD: ACCESS.audience })
    const browser = browserOn(app)
    const client = await register(app)
    const code = await approve(browser, client.authorize, { 'cf-access-jwt-assertion': accessToken })
    await useAndRevoke(app, client, code)
  })
})
