/**
 * Yardhand's own OAuth server end to end, as an app such as claude.ai uses it: it registers, the owner approves in the
 * browser, it trades the code for tokens, calls a tool over MCP and REST, refreshes, and the owner revokes it. The
 * browser keeps every cookie it is given, so an approval that comes to need one more cookie passes unchanged.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeJwt, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, type Env } from '../src/app.js'
import { type ClientDraft, clientsRepo } from '../src/features/clients/repo.js'
import { secrets } from '../src/features/vault/schema.js'
import { dbOAuthStore, generateOAuthKey, hashApiKey, testDb } from '../src/kit/index.js'

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
const gateway = async (env: Partial<Env> = {}, db?: Awaited<ReturnType<typeof testDb>>) => {
  const app = await createApp({
    db: db ?? (await testDb()),
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
    return keep(response)
  }
  /** Keeps the cookies a page sets, also on a page reached without sending any. */
  const keep = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? ''
      const name = pair.slice(0, pair.indexOf('='))
      const value = pair.slice(pair.indexOf('=') + 1)
      if (!value || /max-age=0/i.test(line)) jar.delete(name)
      else jar.set(name, value)
    }
    return response
  }
  return { send, keep, jar }
}
type Browser = ReturnType<typeof browserOn>

const signInWithKey = async (browser: Browser) => {
  const signedIn = await browser.send('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ key: OWNER }),
  })
  expect(signedIn.status).toBe(200)
  expect(browser.jar.has('gw_session')).toBe(true)
}

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

/** Keys an instance keeps across restarts, so its vault and its sign-ins still open after one. */
const instanceKeys = async () => ({
  API_KEYS: `owner:${hashApiKey(OWNER)}`,
  GATEWAY_MASTER_KEY: randomBytes(32).toString('base64'),
  OAUTH_SIGNING_KEY: await generateOAuthKey(),
})

/**
 * An instance as the version before this one left it: its tables made by a start with OAuth off (so nothing is mapped
 * yet) and the sample tools connected, then client rows and sign-ins written as that gateway and kit 1.7.0 wrote them.
 * `update` starts this version on it, with the same keys.
 */
const beforeTheUpdate = async () => {
  const db = await testDb()
  const env = await instanceKeys()
  await gateway({ ...env, OAUTH_SIGNING_KEY: undefined }, db)
  const store = await dbOAuthStore(db)
  const clients = clientsRepo(db)
  const hourFromNow = Math.floor(Date.now() / 1000) + 3600
  return {
    clients,
    /** The row the gateway made on an app's first call: write, every upstream, known by the name the app gave. */
    oauthClient: (name: string, draft: Partial<ClientDraft> = {}) =>
      clients.create({ name, kind: 'oauth', oauthName: name, scope: 'write', upstreams: 'all', ...draft }),
    /** A refresh token as kit 1.7.0 kept it: who, approved by whom, for what; no family, audience or resource. */
    refreshRow: async (name: string, client: string) => {
      const token = `rt_${randomBytes(24).toString('base64url')}`
      const id = createHash('sha256').update(token).digest('hex')
      await store.put(
        'refresh',
        id,
        { client, name, owner: 'owner@example.test', scopes: ['read', 'write'] },
        hourFromNow,
      )
      return token
    },
    /** An access token from before grants: signed by this instance, its `jti` issued, and no grant claim. */
    accessToken: async (name: string, client: string) => {
      const jti = randomBytes(12).toString('base64url')
      await store.put('access', jti, { client }, hourFromNow)
      return new SignJWT({ sub: 'owner@example.test', client_id: client, name, scope: 'read write', jti })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer('http://localhost')
        .setIssuedAt()
        .setExpirationTime(hourFromNow)
        .sign(await importJWK(JSON.parse(env.OAUTH_SIGNING_KEY), 'ES256'))
    },
    /** A kit marker: `revoked-family` by grant (a 1.7.0 refresh row's is the sha256 of its token), `revoked-client`. */
    revoked: (kind: 'revoked-family' | 'revoked-client', id: string) => store.put(kind, id, {}, hourFromNow),
    /** An agent registration kit 1.7.0 claimed, with its claim token (returned) until the agent collected it. */
    claimedRow: async (name: string, id: string, { collected = false } = {}) => {
      await store.put(
        'registration',
        id,
        { name, type: 'agent', claimed: true, owner: 'owner@example.test' },
        hourFromNow,
      )
      if (collected) return undefined
      const token = `clm_${randomBytes(24).toString('base64url')}`
      await store.put(
        'claim-token',
        createHash('sha256').update(token).digest('hex'),
        { registration: id },
        hourFromNow,
      )
      return token
    },
    /** The identity assertion kit 1.7.0 gave an agent with its claim. */
    assertion: async (id: string) =>
      new SignJWT({ sub: id, typ: 'agent_identity', email: 'owner@example.test', email_verified: true })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer('http://localhost')
        .setIssuedAt()
        .setExpirationTime(hourFromNow)
        .sign(await importJWK(JSON.parse(env.OAUTH_SIGNING_KEY), 'ES256')),
    /** The ids in the vault, never their values. */
    secretIds: async () => (await db.select({ id: secrets.id }).from(secrets)).map((row) => row.id),
    update: (keys: Partial<Env> = {}) => createApp({ db, env: { ...env, ...keys } }),
  }
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
  // Revoking ends the sign-in at the kit: its token is no longer one, and its refresh is refused
  const refused = await roll(app, refreshed.json.access_token)
  expect(refused.status).toBe(401)
  expect(((await refused.json()) as { detail: string }).detail).toMatch(/not valid/)
  const after = await tokenFor(app, { grant_type: 'refresh_token', refresh_token: refreshed.json.refresh_token })
  expect([after.status, after.json.error]).toEqual([400, 'invalid_grant'])
}

describe('an app signing in to the gateway', () => {
  it('signs in with the owner’s approval through Access, calls a tool over MCP and REST, refreshes, and revoke ends it', async () => {
    const app = await gateway({ ACCESS_TEAM: ACCESS.team, ACCESS_AUD: ACCESS.audience })
    const browser = browserOn(app)
    const client = await register(app)
    const code = await approve(browser, client.authorize, { 'cf-access-jwt-assertion': accessToken })
    await useAndRevoke(app, client, code)
  })

  it('signs in with the owner’s approval through their session, calls a tool over MCP and REST, refreshes, and revoke ends it', async () => {
    const app = await gateway()
    const browser = browserOn(app)
    await signInWithKey(browser)
    const client = await register(app)
    const consent = await browser.send(client.authorize)
    expect(await consent.text()).toContain('as you (the owner)')
    const code = await approve(browser, client.authorize)
    await useAndRevoke(app, client, code)
  })

  it('behind Access, an approval begun cross-site with Access alone is allowed when the click also carries the session', async () => {
    const app = await gateway({ ACCESS_TEAM: ACCESS.team, ACCESS_AUD: ACCESS.audience })
    const browser = browserOn(app)
    await signInWithKey(browser)
    const client = await register(app)
    // Arriving from the app's site: the strict session cookie stays behind, Access comes along, and the browser keeps
    // the cookie the page binds its approval to
    const consent = browser.keep(
      await app.request(client.authorize, {
        headers: { 'cf-access-jwt-assertion': accessToken, 'sec-fetch-site': 'cross-site' },
      }),
    )
    expect(consent.status).toBe(200)
    const { action, body } = allowFormOf(await consent.text())
    // The click is same-origin: the session cookie and Access both arrive
    const allowed = await browser.send(action, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        'cf-access-jwt-assertion': accessToken,
      },
      body,
    })
    expect(allowed.status).toBe(302)
    expect(new URL(allowed.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy()
  })

  it('a sign-in made before the update refreshes after it, sending resource=<origin>/mcp', async () => {
    // Kit 1.7.0 issued it and its app called once, so a client row of its name exists
    const before = await beforeTheUpdate()
    await before.oauthClient('Sample')
    const client = { clientId: 'client_sample' }
    const old = await before.refreshRow('Sample', client.clientId)
    const app = await before.update()

    const refreshed = await tokenFor(app, {
      grant_type: 'refresh_token',
      refresh_token: old,
      client_id: client.clientId,
      resource: 'http://localhost/mcp',
    })
    expect(refreshed.status).toBe(200)
    expect(refreshed.json.scope).toBe('read write')
    // A sign-in from before audiences never gains one: its tokens are taken wherever they were
    expect(decodeJwt(refreshed.json.access_token).aud).toBeUndefined()
    const mcp = await mcpWith(app, refreshed.json.access_token)
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain('call_tool')
    await mcp.close()
    expect((await roll(app, refreshed.json.access_token)).status).toBe(200)
    // Still the one client it was, and its next refresh goes through too
    const listed = await app.request('/api/clients', { headers: bearer(OWNER) })
    const rows = ((await listed.json()) as { _embedded: { clients: { name: string; kind: string }[] } })._embedded
      .clients
    expect(rows.filter((one) => one.kind === 'oauth').map((one) => one.name)).toEqual(['Sample'])
    const again = await tokenFor(app, {
      grant_type: 'refresh_token',
      refresh_token: refreshed.json.refresh_token,
      client_id: client.clientId,
    })
    expect(again.status).toBe(200)
  })

  it('an app the owner approves at a pack’s address is locked to that pack, its token to that address', async () => {
    const app = await gateway()
    const made = await app.request('/api/packs', {
      method: 'POST',
      headers: bearer(OWNER),
      body: JSON.stringify({ name: 'loud', title: 'Loud' }),
    })
    expect(made.status).toBe(201)
    const browser = browserOn(app)
    await signInWithKey(browser)
    const client = await register(app)
    const pack = 'http://localhost/p/loud/mcp'
    const code = await approve(
      browser,
      client.authorize.replace(
        `resource=${encodeURIComponent('http://localhost/mcp')}`,
        `resource=${encodeURIComponent(pack)}`,
      ),
    )
    const first = await tokenFor(app, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: client.clientId,
      code_verifier: client.verifier,
      resource: pack,
    })
    expect(first.status).toBe(200)
    // Before, the gateway named no resource of its own: the token was for all of it and its client opened no pack
    expect(decodeJwt(first.json.access_token).aud).toBe(pack)
    const atPack = await app.request('/p/loud/api/me', { headers: bearer(first.json.access_token) })
    expect(atPack.status).toBe(200)
    expect(((await atPack.json()) as { pack: { name: string } }).pack.name).toBe('loud')
    const refused = await roll(app, first.json.access_token)
    expect(refused.status).toBe(401)
    expect(((await refused.json()) as { detail: string }).detail).toBe(
      'This sign-in opens Loud only: connect at http://localhost/p/loud/mcp.',
    )
    const refreshed = await tokenFor(app, {
      grant_type: 'refresh_token',
      refresh_token: first.json.refresh_token,
      client_id: client.clientId,
      resource: pack,
    })
    expect(refreshed.status).toBe(200)
    expect(decodeJwt(refreshed.json.access_token).aud).toBe(pack)
  })

  it('also takes the session where Access is in front', async () => {
    const app = await gateway({ ACCESS_TEAM: ACCESS.team, ACCESS_AUD: ACCESS.audience })
    const browser = browserOn(app)
    await signInWithKey(browser)
    const client = await register(app)
    expect((await approve(browser, client.authorize)).length).toBeGreaterThan(0)
  })
})

describe('an app is known by its sign-in, not the name it gives', () => {
  const UNKNOWN = 'This sign-in is not known here: connect again.'
  /** An app registering, approved by the owner's browser, trading its code: the tokens of one new sign-in. */
  const signIn = async (app: App, browser: Browser, name = 'Sample') => {
    const client = await register(app, name)
    const tokens = await tokenFor(app, {
      grant_type: 'authorization_code',
      code: await approve(browser, client.authorize),
      redirect_uri: REDIRECT,
      client_id: client.clientId,
      code_verifier: client.verifier,
      resource: 'http://localhost/mcp',
    })
    expect(tokens.status).toBe(200)
    return { ...client, tokens: tokens.json }
  }
  const signedIn = async (app: App) => {
    const browser = browserOn(app)
    await signInWithKey(browser)
    return browser
  }
  const oauthRows = async (app: App) =>
    (
      (await (await app.request('/api/clients', { headers: bearer(OWNER) })).json()) as {
        _embedded: {
          clients: { id: string; name: string; kind: string; oauthClientId: string | null; revokedAt: string | null }[]
        }
      }
    )._embedded.clients.filter((row) => row.kind === 'oauth')
  type Me = { id: string; scope: string; upstreams: 'all' | string[]; pins: { name: string }[] }
  const meOf = async (app: App, token: string) => {
    const answer = await app.request('/api/me', { headers: bearer(token) })
    return { status: answer.status, json: (await answer.json()) as Me & { detail?: string } }
  }
  const refresh = (app: App, token: string) => tokenFor(app, { grant_type: 'refresh_token', refresh_token: token })
  const revoke = async (app: App, id: string) =>
    expect((await app.request(`/api/clients/${id}`, { method: 'DELETE', headers: bearer(OWNER) })).status).toBe(204)
  /** Refused by the kit: the token is no longer one, the refresh is spent. */
  const expectEnded = async (app: App, access: string, refreshToken: string) => {
    const refused = await roll(app, access)
    expect(refused.status).toBe(401)
    expect(((await refused.json()) as { detail: string }).detail).toMatch(/not valid/)
    const again = await refresh(app, refreshToken)
    expect([again.status, again.json.error]).toEqual([400, 'invalid_grant'])
  }

  it('two apps that register the same name are two clients', async () => {
    const app = await gateway()
    const browser = await signedIn(app)
    const one = await signIn(app, browser)
    // The row is made when the sign-in is, before any call
    expect((await oauthRows(app)).map((row) => [row.name, row.oauthClientId])).toEqual([['Sample', one.clientId]])
    const two = await signIn(app, browser)
    expect((await roll(app, one.tokens.access_token)).status).toBe(200)
    expect((await roll(app, two.tokens.access_token)).status).toBe(200)
    const rows = await oauthRows(app)
    expect(rows.map((row) => [row.name, row.oauthClientId])).toEqual([
      ['Sample', one.clientId],
      ['Sample', two.clientId],
    ])
    expect((await meOf(app, one.tokens.access_token)).json.id).toBe(rows[0]?.id)
    expect((await meOf(app, two.tokens.access_token)).json.id).toBe(rows[1]?.id)
  })

  it('revoke ends the sign-in at the kit: the access token is refused and the refresh is invalid_grant', async () => {
    const app = await gateway()
    const browser = await signedIn(app)
    const { tokens } = await signIn(app, browser)
    const refreshed = await refresh(app, tokens.refresh_token)
    expect(refreshed.status).toBe(200)
    const [row] = await oauthRows(app)
    await revoke(app, row?.id ?? '')
    expect((await roll(app, tokens.access_token)).status).toBe(401)
    await expectEnded(app, refreshed.json.access_token, refreshed.json.refresh_token)
    const mcp = await app.request('/mcp', {
      method: 'POST',
      headers: { ...bearer(refreshed.json.access_token), accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(mcp.status).toBe(401)
  })

  it('a new connection after the owner revoked a same-named one is a new client and works', async () => {
    const app = await gateway()
    const browser = await signedIn(app)
    await signIn(app, browser)
    const [first] = await oauthRows(app)
    await revoke(app, first?.id ?? '')
    const again = await signIn(app, browser)
    expect((await roll(app, again.tokens.access_token)).status).toBe(200)
    const rows = await oauthRows(app)
    expect(rows.map((row) => [row.name, Boolean(row.revokedAt)])).toEqual([
      ['Sample', true],
      ['Sample', false],
    ])
    expect((await meOf(app, again.tokens.access_token)).json.id).toBe(rows[1]?.id)
  })

  it('every sign-in made before the update keeps the row it used, with its pins and allowlist', async () => {
    const before = await beforeTheUpdate()
    const id = await before.oauthClient('Sample', { pins: ['sample.roll_dice'], upstreams: ['sample'] })
    const laptop = await before.refreshRow('Sample', 'client_laptop')
    const phone = await before.refreshRow('Sample', 'client_phone')
    const app = await before.update()
    for (const old of [laptop, phone]) {
      const refreshed = await refresh(app, old)
      expect(refreshed.status).toBe(200)
      const me = await meOf(app, refreshed.json.access_token)
      expect(me.json).toMatchObject({ id, upstreams: ['sample'] })
      expect(me.json.pins.map((pin) => pin.name)).toEqual(['sample.roll_dice'])
      expect((await roll(app, refreshed.json.access_token)).status).toBe(200)
    }
    expect((await oauthRows(app)).map((row) => row.id)).toEqual([id])
  })

  it('revoking a row shared by two pre-update sign-ins ends both', async () => {
    const before = await beforeTheUpdate()
    const id = await before.oauthClient('Sample')
    const olds = [await before.refreshRow('Sample', 'client_laptop'), await before.refreshRow('Sample', 'client_phone')]
    const app = await before.update()
    const refreshed = await Promise.all(olds.map((old) => refresh(app, old)))
    for (const one of refreshed) expect((await roll(app, one.json.access_token)).status).toBe(200)
    await revoke(app, id)
    for (const one of refreshed) await expectEnded(app, one.json.access_token, one.json.refresh_token)
  })

  it('a narrowed or ended row stays narrow or ended for every pre-update sign-in of its name', async () => {
    const before = await beforeTheUpdate()
    const narrow = await before.oauthClient('Sample', { scope: 'read', upstreams: [] })
    await before.oauthClient('Ended', { expiresAt: '2026-01-01T00:00:00.000Z' })
    const olds = [await before.refreshRow('Sample', 'client_laptop'), await before.refreshRow('Sample', 'client_phone')]
    const ended = await before.refreshRow('Ended', 'client_ended')
    const app = await before.update()
    for (const old of olds) {
      const me = await meOf(app, (await refresh(app, old)).json.access_token)
      expect(me.json).toMatchObject({ id: narrow, scope: 'read', upstreams: [] })
    }
    const refused = await roll(app, (await refresh(app, ended)).json.access_token)
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as { detail: string }).detail).toBe(
      'This key expired on 1 Jan 2026: the owner can issue a new one in /app.',
    )
  })

  it('a pre-update sign-in of a revoked name is ended at start', async () => {
    const before = await beforeTheUpdate()
    await before.clients.revoke(await before.oauthClient('Gone'))
    const old = await before.refreshRow('Gone', 'client_gone')
    const app = await before.update()
    const refreshed = await refresh(app, old)
    expect([refreshed.status, refreshed.json.error]).toEqual([400, 'invalid_grant'])
    expect((await oauthRows(app)).map((row) => [row.name, Boolean(row.revokedAt)])).toEqual([['Gone', true]])
  })

  /** A request at one of the gateway's doors, as an app connecting there sends it. */
  const knock = (app: App, [path, method]: readonly [string, 'GET' | 'POST'], authorization: string) =>
    app.request(path, {
      method,
      headers: { authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      ...(method === 'POST'
        ? {
            body: JSON.stringify(
              path.endsWith('/calls')
                ? { tool: 'sample.roll_dice', arguments: { count: 2, sides: 6 } }
                : { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
            ),
          }
        : {}),
    })
  /** A sign-in the start never saw, refreshed once: the kit takes it, the gateway knows no row for it. */
  const unseenSignIn = async (app: App, before: Awaited<ReturnType<typeof beforeTheUpdate>>) => {
    const refreshed = await refresh(app, await before.refreshRow('Sample', 'client_unseen'))
    expect(refreshed.status).toBe(200)
    return refreshed.json
  }
  const challengeOf = (response: Response) => {
    const header = response.headers.get('www-authenticate') ?? ''
    return {
      error: /error="([^"]+)"/.exec(header)?.[1],
      pointer: /resource_metadata="([^"]+)"/.exec(header)?.[1],
      scope: /scope="([^"]+)"/.exec(header)?.[1],
    }
  }

  it('a token whose grant has no row is refused and makes none', async () => {
    const before = await beforeTheUpdate()
    const app = await before.update()
    // Each door gets its own sign-in: the first refusal ends the sign-in at the kit
    for (const door of [
      ['/api/calls', 'POST'],
      ['/mcp', 'POST'],
      // The passthrough and the link proxy ask it to connect again too
      ['/u/sample/mcp', 'POST'],
      ['/u/sample/r/recipes/1', 'GET'],
    ] as const) {
      const tokens = await unseenSignIn(app, before)
      const refused = await knock(app, door, `Bearer ${tokens.access_token}`)
      expect([door[0], refused.status]).toEqual([door[0], 401])
      expect(refused.headers.get('www-authenticate')).toMatch(/^Bearer /)
      expect(((await refused.json()) as { detail: string }).detail).toBe(UNKNOWN)
    }
    expect(await oauthRows(app)).toEqual([])
  })

  it('the 401 for an unknown sign-in points where the kit’s own does, and its refresh is then invalid_grant', async () => {
    const before = await beforeTheUpdate()
    const app = await before.update()
    const made = await app.request('/api/packs', {
      method: 'POST',
      headers: bearer(OWNER),
      body: JSON.stringify({ name: 'loud', title: 'Loud' }),
    })
    expect(made.status).toBe(201)
    // A pack renamed while it had a key: its old name still opens, and must not give its new one away
    const owner = (path: string, method: string, body: unknown) =>
      app.request(path, { method, headers: bearer(OWNER), body: JSON.stringify(body) })
    expect((await owner('/api/packs', 'POST', { name: 'shed', title: 'Shed' })).status).toBe(201)
    const key = { name: 'Sam', scope: 'write', packs: ['shed'], expiresIn: '7d' }
    expect((await owner('/api/clients', 'POST', key)).status).toBe(201)
    expect((await owner('/api/packs/shed', 'PATCH', { name: 'garden' })).status).toBe(200)
    for (const door of [
      ['/api/calls', 'POST'],
      ['/mcp', 'POST'],
      ['/p/loud/mcp', 'POST'],
      ['/p/loud/api/calls', 'POST'],
      ['/p/shed/mcp', 'POST'],
      ['/p/shed/api/calls', 'POST'],
    ] as const) {
      const tokens = await unseenSignIn(app, before)
      const refused = await knock(app, door, `Bearer ${tokens.access_token}`)
      expect([door[0], refused.status]).toEqual([door[0], 401])
      expect(((await refused.json()) as { detail: string }).detail).toBe(UNKNOWN)
      const kits = challengeOf(await knock(app, door, 'Bearer not-a-token'))
      expect(kits.pointer).toBeTruthy()
      expect([door[0], challengeOf(refused)]).toEqual([door[0], { ...kits, error: 'invalid_token' }])
      expect(kits.scope).toBe('read write')
      // Ended at the kit: the app's next refresh is refused, so it authorizes again
      const again = await refresh(app, tokens.refresh_token)
      expect([door[0], again.status, again.json.error]).toEqual([door[0], 400, 'invalid_grant'])
    }
    expect(await oauthRows(app)).toEqual([])
  })

  it('an access token from before the update finds its row by name and makes none', async () => {
    const before = await beforeTheUpdate()
    const id = await before.oauthClient('Sample', { pins: ['sample.roll_dice'] })
    const app = await before.update()
    const known = await meOf(app, await before.accessToken('Sample', 'client_laptop'))
    expect(known.json).toMatchObject({ id })
    const stranger = await meOf(app, await before.accessToken('Stranger', 'client_stranger'))
    expect([stranger.status, stranger.json.detail]).toEqual([401, UNKNOWN])
    expect((await oauthRows(app)).map((row) => row.id)).toEqual([id])
  })

  it('the mapping runs once', async () => {
    const before = await beforeTheUpdate()
    // A sign-in whose app never called: the start makes the row its first call would have made
    const old = await before.refreshRow('Sample', 'client_laptop')
    const app = await before.update()
    const refreshed = await refresh(app, old)
    expect(await meOf(app, refreshed.json.access_token)).toMatchObject({
      status: 200,
      json: { name: 'Sample', scope: 'write', upstreams: 'all' },
    })
    // Written after the first start, it is not mapped by the next one
    const later = await before.refreshRow('Later', 'client_later')
    const restarted = await before.update()
    const unseen = await meOf(restarted, (await refresh(restarted, later)).json.access_token)
    expect([unseen.status, unseen.json.detail]).toEqual([401, UNKNOWN])
    expect((await roll(restarted, refreshed.json.access_token)).status).toBe(200)
    expect((await oauthRows(restarted)).map((row) => row.name)).toEqual(['Sample'])
  })

  it('a pre-update sign-in with a blank name gets a row shown as an unnamed app, still known by that name', async () => {
    const before = await beforeTheUpdate()
    const old = await before.refreshRow(' ', 'client_blank')
    const app = await before.update()
    const [row] = await oauthRows(app)
    expect(row?.name).toBe('Unnamed app')
    expect((await meOf(app, (await refresh(app, old)).json.access_token)).json.id).toBe(row?.id)
    expect((await meOf(app, await before.accessToken(' ', 'client_blank'))).json.id).toBe(row?.id)
  })

  it('a pre-update sign-in the kit already refuses gets no row at start', async () => {
    const before = await beforeTheUpdate()
    const replayed = await before.refreshRow('Ghost', 'client_ghost')
    await before.revoked('revoked-family', createHash('sha256').update(replayed).digest('hex'))
    await before.claimedRow('Reg', 'client_reg')
    await before.revoked('revoked-client', 'client_reg')
    const app = await before.update()
    expect(await oauthRows(app)).toEqual([])
    const refreshed = await refresh(app, replayed)
    expect([refreshed.status, refreshed.json.error]).toEqual([400, 'invalid_grant'])
  })

  it('a pre-update agent claimed but not yet collected is mapped at start, and collecting reaches that row', async () => {
    const before = await beforeTheUpdate()
    const claim = await before.claimedRow('Agent', 'reg_waiting')
    const app = await before.update()
    const [row] = await oauthRows(app)
    expect(row?.name).toBe('Agent')
    const collected = await tokenFor(app, {
      grant_type: 'urn:workos:agent-auth:grant-type:claim',
      claim_token: claim ?? '',
    })
    expect(collected.status).toBe(200)
    expect((await meOf(app, collected.json.access_token)).json.id).toBe(row?.id)
    expect((await meOf(app, (await refresh(app, collected.json.refresh_token)).json.access_token)).json.id).toBe(
      row?.id,
    )
    expect((await oauthRows(app)).map((one) => one.id)).toEqual([row?.id])
  })

  it('a pre-update agent whose claim was collected gets no row: its identity assertion is refused', async () => {
    const before = await beforeTheUpdate()
    await before.claimedRow('Agent', 'reg_collected', { collected: true })
    const app = await before.update()
    expect(await oauthRows(app)).toEqual([])
    const asserted = await tokenFor(app, {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: await before.assertion('reg_collected'),
    })
    expect([asserted.status, asserted.json.error]).toEqual([400, 'invalid_grant'])
    expect(await oauthRows(app)).toEqual([])
  })

  it('a refresh token of the same name as a collected agent still maps, to one row', async () => {
    const before = await beforeTheUpdate()
    await before.claimedRow('Agent', 'reg_collected', { collected: true })
    const old = await before.refreshRow('Agent', 'client_agent')
    const app = await before.update()
    const [row, ...more] = await oauthRows(app)
    expect([row?.name, more]).toEqual(['Agent', []])
    const refreshed = await refresh(app, old)
    expect(refreshed.status).toBe(200)
    expect((await meOf(app, refreshed.json.access_token)).json.id).toBe(row?.id)
  })

  it('a start under another master key still comes up, and the mapping leaves nothing in the vault', async () => {
    const before = await beforeTheUpdate()
    const old = await before.refreshRow('Sample', 'client_laptop')
    await before.update()
    const app = await before.update({ GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') })
    expect((await roll(app, (await refresh(app, old)).json.access_token)).status).toBe(200)
    expect(await before.secretIds()).toEqual([])
  })
})

describe('the owner’s session at the approval pages', () => {
  /** Every link on a page, as the browser reads it. */
  const hrefsOf = (html: string) =>
    [...html.matchAll(/href="([^"]*)"/g)].map((match) =>
      (match[1] ?? '').replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replaceAll('&amp;', '&'),
    )

  it('without a session or Access, authorize says sign in first and links to sign-in', async () => {
    const app = await gateway()
    const client = await register(app)
    // Typed in, from this site, and cross-site once past the Continue page
    for (const site of [null, 'same-origin', 'cross-site']) {
      const query = site === 'cross-site' ? `${client.authorize}&hop=1` : client.authorize
      const page = await app.request(query, { headers: site ? { 'sec-fetch-site': site } : {} })
      expect(page.status).toBe(401)
      expect(page.headers.get('cache-control')).toBe('no-store')
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      const html = await page.text()
      expect(html).toContain('Sign in to Yardhand first')
      // Back to the same request once signed in, without the hop
      expect(hrefsOf(html)).toEqual([`/app/sign-in?next=${encodeURIComponent(client.authorize)}`])
    }
  })

  it('an approval posted from another site is refused', async () => {
    const app = await gateway()
    const browser = browserOn(app)
    await signInWithKey(browser)
    const client = await register(app)
    const { action, body } = allowFormOf(await (await browser.send(client.authorize)).text())
    const form = { 'content-type': 'application/x-www-form-urlencoded' }
    for (const headers of [
      { ...form, 'sec-fetch-site': 'cross-site' },
      { ...form, 'sec-fetch-site': 'same-site' },
      { ...form, origin: 'https://elsewhere.example.test' },
      // A sandboxed frame or a redirect across sites says only `null`
      { ...form, origin: 'null' },
      form,
    ]) {
      const posted = await browser.send(action, { method: 'POST', headers, body })
      expect(posted.status).toBe(403)
      expect(posted.headers.get('location')).toBeNull()
    }
    // The ticket was never used: the owner's own approval still goes through
    const allowed = await browser.send(action, {
      method: 'POST',
      headers: { ...form, 'sec-fetch-site': 'same-origin' },
      body,
    })
    expect(new URL(allowed.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy()
  })

  it('an Origin of null is from no site: the consent page still opens, and a write it carries is refused', async () => {
    const app = await gateway()
    const browser = browserOn(app)
    await signInWithKey(browser)
    const client = await register(app)
    const consent = await browser.send(client.authorize, { headers: { origin: 'null' } })
    expect(consent.status).toBe(200)
    expect(await consent.text()).toContain('Allow <strong>Sample</strong>')
    const signIn = await browser.send('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null' },
      body: JSON.stringify({ key: OWNER }),
    })
    expect(signIn.status).toBe(403)
  })

  it('the session is not the owner at /oauth/claim', async () => {
    const app = await gateway()
    const browser = browserOn(app)
    await signInWithKey(browser)
    const registered = await app.request('/agent/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'service_auth', login_hint: 'owner@example.test' }),
    })
    const { claim } = (await registered.json()) as { claim: { verification_uri: string; user_code: string } }
    const claimPage = new URL(claim.verification_uri)
    expect((await browser.send(`${claimPage.pathname}${claimPage.search}`)).status).toBe(401)
    const typed = await browser.send('/oauth/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      body: new URLSearchParams({
        claim_attempt_token: claimPage.searchParams.get('claim_attempt_token') ?? '',
        user_code: claim.user_code,
      }).toString(),
    })
    expect(typed.status).toBe(403)
  })

  it('an x-gateway-session header sent in is not a session', async () => {
    const app = await gateway()
    const client = await register(app)
    const said = await app.request('/api/session', { headers: { 'x-gateway-session': '1' } })
    expect(((await said.json()) as { signedIn: boolean }).signedIn).toBe(false)
    expect((await app.request(client.authorize, { headers: { 'x-gateway-session': '1' } })).status).toBe(401)
    // A session that no longer exists is not one either
    expect((await app.request(client.authorize, { headers: { cookie: 'gw_session=made-up' } })).status).toBe(401)
  })

  it('arriving cross-site without the cookie, the owner gets a Continue page whose link keeps the path and query; following it with the cookie shows the consent', async () => {
    const app = await gateway()
    const browser = browserOn(app)
    await signInWithKey(browser)
    const client = await register(app)
    // claude.ai sends the owner here: a cross-site navigation, so the browser withholds the SameSite=Strict cookie
    const arrived = await app.request(`${client.authorize}&hop=0`, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(arrived.status).toBe(200)
    expect(arrived.headers.get('cache-control')).toBe('no-store')
    expect(arrived.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    const html = await arrived.text()
    expect(html).toContain('Continue to approve this app in Yardhand')
    const [link] = hrefsOf(html)
    const followed = new URL(link ?? '', 'http://localhost')
    expect(followed.pathname).toBe('/oauth/authorize')
    expect(followed.searchParams.getAll('hop')).toEqual(['1'])
    followed.searchParams.delete('hop')
    expect(Object.fromEntries(followed.searchParams)).toEqual(
      Object.fromEntries(new URL(client.authorize, 'http://localhost').searchParams),
    )
    // The click is a same-origin navigation: the cookie goes with it
    const consent = await browser.send(link ?? '', { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(consent.status).toBe(200)
    expect(await consent.text()).toContain('Allow <strong>Sample</strong>')
    // With the cookie, or Access, there is nothing to continue past
    const direct = await browser.send(client.authorize, { headers: { 'sec-fetch-site': 'cross-site' } })
    expect(await direct.text()).toContain('Allow <strong>Sample</strong>')
  })

  it('escapes the request in the Continue page’s link', async () => {
    const app = await gateway()
    const page = await app.request('/oauth/authorize?state=%22%3E%3Cscript%3Ealert(1)%3C/script%3E', {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    const html = await page.text()
    expect(html).not.toContain('<script>')
    expect(hrefsOf(html)[0]).toMatch(/^\/oauth\/authorize\?/)
  })

  it('without OAuth on, there is no approval to continue to or sign in for', async () => {
    const app = await gateway({ OAUTH_SIGNING_KEY: undefined })
    for (const query of ['', '&hop=1']) {
      const page = await app.request(`/oauth/authorize?client_id=sample${query}`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      })
      expect(page.status).not.toBe(200)
      const text = await page.text()
      expect(text).not.toContain('Continue to approve this app')
      expect(text).not.toContain('Sign in to Yardhand first')
    }
  })
})

describe('the sign-in log', () => {
  it('the sign-in log names the resource and never a code or token', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)))
    try {
      const app = await gateway()
      const browser = browserOn(app)
      await signInWithKey(browser)
      const registered = await app.request('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7, 10.0.0.2' },
        body: JSON.stringify({ client_name: 'Sample', redirect_uris: [REDIRECT] }),
      })
      const clientId = ((await registered.json()) as { client_id: string }).client_id
      const verifier = randomBytes(32).toString('base64url')
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        state: 'state-from-the-app',
        resource: 'http://localhost/mcp',
      })
      // Sent by the app's site: the first leg says where from, the click after it is this site's own
      const arrived = await app.request(`/oauth/authorize?${query}`, {
        headers: { 'sec-fetch-site': 'cross-site', referer: 'https://app.example.test/chat/private-thread?x=1' },
      })
      expect(arrived.status).toBe(200)
      const code = await approve(browser, `/oauth/authorize?${query}&hop=1`)
      const tokens = await tokenFor(app, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: 'http://localhost/mcp',
      })
      expect(tokens.status).toBe(200)
      const refreshed = await tokenFor(app, { grant_type: 'refresh_token', refresh_token: tokens.json.refresh_token })
      expect(refreshed.status).toBe(200)
      // An app known by a client_id URL, which this gateway doesn't take yet, and one that sends no resource
      await app.request('/oauth/authorize?client_id=https%3A%2F%2Fapp.example.test%2Fclient.json&redirect_uri=x')
      await app.request(`/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}`)

      const logged = lines.filter((line) => line.startsWith('sign-in '))
      // The same short id on every line of one app, and never its client_id
      const id = /id=([0-9a-f]{8}) /.exec(logged[0] ?? '')?.[1]
      expect(logged[0]).toBe(
        `sign-in register 201: client="Sample" id=${id} callbacks=http://localhost:9 address=203.0.113.7`,
      )
      expect(logged[1]).toBe(
        `sign-in authorize 200: client="Sample" by=dcr id=${id} resource="http://localhost/mcp" callback=http://localhost:9 sec-fetch-site=cross-site referer=https://app.example.test`,
      )
      // The consent page and the approval it posts, then the code and the refresh
      expect(logged[2]).toBe(
        `sign-in authorize 200: client="Sample" by=dcr id=${id} resource="http://localhost/mcp" callback=http://localhost:9 sec-fetch-site=absent referer=absent hop=1`,
      )
      expect(logged[3]).toBe(
        `sign-in token 200: grant=authorization_code client="Sample" by=dcr id=${id} resource="http://localhost/mcp" redirect_uri=sent callback=http://localhost:9 sec-fetch-site=absent referer=absent`,
      )
      expect(logged[4]).toBe(
        'sign-in token 200: grant=refresh_token client=none resource=none redirect_uri=absent sec-fetch-site=absent referer=absent',
      )
      expect(logged[5]).toBe(
        `sign-in authorize 401: client=unknown by=url id=${/id=(\w+)/.exec(logged[5] ?? '')?.[1]} resource=none callback=unreadable sec-fetch-site=absent referer=absent`,
      )
      expect(logged[6]).toMatch(/^sign-in authorize 401: client="Sample" by=dcr id=\w+ resource=none /)
      expect(logged).toHaveLength(7)

      // Nothing secret, nor what would let anyone replay a step
      const all = logged.join('\n')
      for (const secret of [
        code,
        verifier,
        clientId,
        tokens.json.access_token,
        tokens.json.refresh_token,
        refreshed.json.access_token,
        refreshed.json.refresh_token,
        'state-from-the-app',
        browser.jar.get('gw_session') ?? 'no cookie',
        OWNER,
        'private-thread',
        'consent_',
      ])
        expect(all).not.toContain(secret)
    } finally {
      spy.mockRestore()
    }
  })

  it('logs a sign-in made over a real connection, with the address it came from', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)))
    const app = await gateway()
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const registered = await fetch(`${origin}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Sample', redirect_uris: [REDIRECT] }),
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
      })
      expect((await fetch(`${origin}/oauth/authorize?${query}`)).status).toBe(401)
      const browser = browserOn(app)
      await signInWithKey(browser)
      const code = await approve(browser, `/oauth/authorize?${query}`)
      const tokens = await fetch(`${origin}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        }).toString(),
      })
      expect(tokens.status).toBe(200)
      expect(((await tokens.json()) as Tokens).refresh_token).toBeTruthy()
      const logged = lines.filter((line) => line.startsWith('sign-in '))
      expect(logged[0]).toMatch(
        /^sign-in register 201: client="Sample" id=\w{8} callbacks=http:\/\/localhost:9 address=(::ffff:)?127\.0\.0\.1$/,
      )
      expect(logged[1]).toMatch(/^sign-in authorize 401: client="Sample" by=dcr /)
      expect(logged.at(-1)).toMatch(/^sign-in token 200: grant=authorization_code client="Sample" by=dcr /)
    } finally {
      spy.mockRestore()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('writes an address only when it reads as one', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)))
    try {
      const app = await gateway()
      await app.request('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7" by=dcr' },
        body: JSON.stringify({ client_name: 'Sample', redirect_uris: [REDIRECT] }),
      })
      expect(lines.find((line) => line.startsWith('sign-in register'))).toMatch(/ address=unreadable$/)
    } finally {
      spy.mockRestore()
    }
  })

  it('says only what a resource names, never its query', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)))
    try {
      const app = await gateway()
      const client = await register(app)
      const authorize = client.authorize.replace(
        'resource=http%3A%2F%2Flocalhost%2Fmcp',
        'resource=https%3A%2F%2Fgw.example.com%2Fp%2Floud%2Fmcp%3Ftoken%3Dhidden&resource=%22%0Afake&resource=https%3A%2F%2Fsam%3Asecret%40gw.example.com%2Fmcp',
      )
      await app.request(authorize)
      const line = lines.filter((one) => one.startsWith('sign-in authorize'))[0] ?? ''
      expect(line).toContain(
        'resource="https://gw.example.com/p/loud/mcp" (cut to origin and path),"not a URL","https://gw.example.com/mcp" (cut to origin and path)',
      )
      expect(line).not.toContain('hidden')
      expect(line).not.toContain('secret')
      expect(line.split('\n')).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('reads every resource a token request sent as JSON, a list too', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)))
    try {
      const app = await gateway()
      await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'not-a-token',
          resource: ['https://gw.example.com/mcp', 'https://gw.example.com/p/loud/mcp', 7],
        }),
      })
      expect(lines.find((line) => line.startsWith('sign-in token'))).toContain(
        'resource="https://gw.example.com/mcp","https://gw.example.com/p/loud/mcp" ',
      )
    } finally {
      spy.mockRestore()
    }
  })
})

describe('a pack address asks for sign-in at its own resource', () => {
  /** An MCP initialize or a call, as an app connecting at `path` sends it. */
  const knock = (app: App, path: string, token?: string, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(
        path.endsWith('/calls')
          ? { tool: 'sample.roll_dice', arguments: { count: 1, sides: 6 } }
          : { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      ),
    })
  const pointerOf = (response: Response) =>
    /resource_metadata="([^"]+)"/.exec(response.headers.get('www-authenticate') ?? '')?.[1]
  const detailOf = async (response: Response) => ((await response.json()) as { detail?: string }).detail
  const owner = (app: App, path: string, method = 'GET', body?: unknown) =>
    app.request(path, { method, headers: bearer(OWNER), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  /** A gateway with the pack `desk` (Front desk) holding the dice, and `loud` beside it. */
  const withDesk = async (env: Partial<Env> = {}) => {
    const app = await gateway(env)
    expect((await owner(app, '/api/packs', 'POST', { name: 'desk', title: 'Front desk' })).status).toBe(201)
    expect((await owner(app, '/api/packs', 'POST', { name: 'loud', title: 'Loud' })).status).toBe(201)
    const added = await owner(app, '/api/packs/desk', 'PATCH', { add: { tools: [{ name: 'sample.roll_dice' }] } })
    expect(added.status).toBe(200)
    return app
  }
  /** The owner approves an app that asked for `resource`: the tokens of that one sign-in. */
  const signInFor = async (app: App, resource: string, scope = 'read write') => {
    const browser = browserOn(app)
    await signInWithKey(browser)
    const client = await register(app)
    const authorize = client.authorize
      .replace(`resource=${encodeURIComponent('http://localhost/mcp')}`, `resource=${encodeURIComponent(resource)}`)
      .replace('scope=read+write', `scope=${encodeURIComponent(scope)}`)
    const code = await approve(browser, authorize)
    const answer = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: client.clientId,
        code_verifier: client.verifier,
        resource,
      }).toString(),
    })
    expect(answer.status).toBe(200)
    return { ...client, tokens: (await answer.json()) as Tokens }
  }
  /** The app's MCP connection at a pack's address, answered in-process. */
  const mcpAt = async (app: App, url: string, token: string) => {
    const client = new Client({ name: 'Sample', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: async (to, init) => app.request(new Request(to, init)),
      }),
    )
    return client
  }

  it('the 401 at /p/desk/mcp points at metadata whose resource is that URL and whose server is the root', async () => {
    const app = await withDesk()
    for (const [address, metadata] of [
      ['/p/desk/mcp', '/.well-known/oauth-protected-resource/p/desk/mcp'],
      // A pack's REST is the same resource as its MCP
      ['/p/desk/api/calls', '/.well-known/oauth-protected-resource/p/desk/mcp'],
      ['/mcp', '/.well-known/oauth-protected-resource/mcp'],
      ['/mcp/p/desk', '/.well-known/oauth-protected-resource/mcp'],
    ] as const) {
      const refused = await knock(app, address)
      expect([address, refused.status]).toEqual([address, 401])
      const pointer = pointerOf(refused) ?? ''
      expect([address, new URL(pointer).pathname]).toEqual([address, metadata])
      const document = (await (await app.request(new URL(pointer).pathname)).json()) as {
        resource: string
        authorization_servers: string[]
      }
      expect([address, document.resource]).toEqual([address, `http://localhost${metadata.slice(37)}`])
      expect(document.authorization_servers).toEqual(['http://localhost'])
    }
  })

  it('without a signing key, the 401 carries no metadata pointer', async () => {
    const app = await gateway({ OAUTH_SIGNING_KEY: undefined })
    expect((await owner(app, '/api/packs', 'POST', { name: 'desk', title: 'Front desk' })).status).toBe(201)
    for (const address of ['/p/desk/mcp', '/p/desk/api/calls', '/mcp']) {
      const refused = await knock(app, address)
      expect([address, refused.status]).toEqual([address, 401])
      expect([address, pointerOf(refused)]).toEqual([address, undefined])
    }
  })

  it('metadata for /p/<any valid name>/mcp answers alike for a pack that exists and one that does not; an invalid name is 404', async () => {
    const app = await withDesk()
    const documentAt = async (path: string) => {
      const answer = await app.request(`/.well-known/oauth-protected-resource${path}`)
      return { status: answer.status, body: answer.status === 200 ? ((await answer.json()) as object) : null }
    }
    const desk = await documentAt('/p/desk/mcp')
    const nowhere = await documentAt('/p/nowhere/mcp')
    expect(desk.status).toBe(200)
    expect(JSON.stringify(nowhere.body).replaceAll('nowhere', 'desk')).toBe(JSON.stringify(desk.body))
    for (const path of ['/p/Desk/mcp', '/p/desk', '/p/desk/api', '/p/desk/mcp/x', '/p/-desk/mcp'])
      expect([path, (await documentAt(path)).status]).toEqual([path, 404])
  })

  it('an owner-approved token for desk works at /p/desk/mcp and /p/desk/api, a tool’s in-process call included, and is refused at /mcp, /api, with x-gateway-pack, at /mcp/p/desk and at another pack, naming desk’s address', async () => {
    const app = await withDesk()
    const { tokens } = await signInFor(app, 'http://localhost/p/desk/mcp')
    const token = tokens.access_token
    const mcp = await mcpAt(app, 'http://localhost/p/desk/mcp', token)
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain('sample.roll_dice')
    const rolled = await mcp.callTool({
      name: 'call_tool',
      arguments: { name: 'sample.roll_dice', arguments: { count: 1, sides: 6 } },
    })
    expect(rolled.isError).toBeFalsy()
    const described = await mcp.callTool({ name: 'describe_tool', arguments: { name: 'sample.roll_dice' } })
    expect(described.isError).toBeFalsy()
    await mcp.close()
    const called = await app.request('/p/desk/api/calls', {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({ tool: 'sample.roll_dice', arguments: { count: 1, sides: 6 } }),
    })
    expect(called.status).toBe(200)
    const elsewhere = 'This sign-in opens Front desk only: connect at http://localhost/p/desk/mcp.'
    for (const [path, headers] of [
      ['/mcp', {}],
      ['/api/calls', {}],
      ['/mcp', { 'x-gateway-pack': 'desk' }],
      ['/api/calls', { 'x-gateway-pack': 'desk' }],
      ['/mcp/p/desk', {}],
      ['/p/loud/mcp', {}],
      ['/p/loud/api/calls', {}],
    ] as const) {
      const refused = await knock(app, path, token, headers)
      expect([path, headers, refused.status, await detailOf(refused)]).toEqual([path, headers, 401, elsewhere])
    }
    // Read only: MCP's door is a relay at a pack's address too, so the read token initializes there
    const reader = await signInFor(app, 'http://localhost/p/desk/mcp', 'read')
    expect((await knock(app, '/p/desk/mcp', reader.tokens.access_token)).status).toBe(200)
  })

  it('a pack token survives a rename; after the old name is freed and taken by another pack, it works at the new address, is refused at the retaken one, and is never told the other pack’s title', async () => {
    const app = await withDesk()
    const { tokens } = await signInFor(app, 'http://localhost/p/desk/mcp')
    const token = tokens.access_token
    expect((await owner(app, '/api/packs/desk', 'PATCH', { name: 'front' })).status).toBe(200)
    for (const path of ['/p/front/mcp', '/p/desk/mcp'])
      expect([path, (await knock(app, path, token)).status]).toEqual([path, 200])
    expect((await owner(app, '/api/packs/front/names/desk', 'DELETE')).status).toBe(204)
    expect((await owner(app, '/api/packs', 'POST', { name: 'desk', title: 'Secret plans' })).status).toBe(201)
    expect((await knock(app, '/p/front/mcp', token)).status).toBe(200)
    const retaken = await knock(app, '/p/desk/mcp', token)
    expect(retaken.status).toBe(401)
    const detail = await detailOf(retaken)
    expect(detail).toBe('This sign-in opens Front desk only: connect at http://localhost/p/front/mcp.')
    expect(detail).not.toContain('Secret')
  })

  it('a root token and an aud-less token are taken at a pack’s own address and with the header, where the gateway answers them as before', async () => {
    const before = await beforeTheUpdate()
    // The ones from before: one known by its grant, one access token known by its name for its last hour
    await before.oauthClient('Older')
    const old = await before.refreshRow('Older', 'client_older')
    const app = await before.update()
    expect((await owner(app, '/api/packs', 'POST', { name: 'desk', title: 'Front desk' })).status).toBe(201)
    const root = (await signInFor(app, 'http://localhost/mcp')).tokens.access_token
    expect(decodeJwt(root).aud).toBe('http://localhost/mcp')
    const older = await tokenFor(app, { grant_type: 'refresh_token', refresh_token: old })
    expect(older.status).toBe(200)
    const audless = [older.json.access_token, await before.accessToken('Older', 'client_older')]
    for (const token of [root, ...audless]) {
      expect((await knock(app, '/api/calls', token)).status).toBe(200)
      // Past the sign-in, the gateway answers as it always has: an app not locked to packs opens none
      for (const [path, headers] of [
        ['/p/desk/mcp', {}],
        ['/p/desk/api/calls', {}],
        ['/mcp', { 'x-gateway-pack': 'desk' }],
        ['/api/calls', { 'x-gateway-pack': 'desk' }],
      ] as const) {
        const answer = await knock(app, path, token, headers)
        expect([path, answer.status, await detailOf(answer)]).toEqual([
          path,
          403,
          "This key isn't locked to packs: connect to /mcp, which serves everything it may reach.",
        ])
      }
    }
  })

  it('an app connected at /p/desk/mcp before the update, refreshing with resource=<origin>/mcp, is answered there as before', async () => {
    const before = await beforeTheUpdate()
    await before.oauthClient('Sample')
    const old = await before.refreshRow('Sample', 'client_sample')
    const app = await before.update()
    expect((await owner(app, '/api/packs', 'POST', { name: 'desk', title: 'Front desk' })).status).toBe(201)
    const refreshed = await tokenFor(app, {
      grant_type: 'refresh_token',
      refresh_token: old,
      client_id: 'client_sample',
      resource: 'http://localhost/mcp',
    })
    expect(refreshed.status).toBe(200)
    expect(decodeJwt(refreshed.json.access_token).aud).toBeUndefined()
    const there = await knock(app, '/p/desk/mcp', refreshed.json.access_token)
    expect([there.status, await detailOf(there)]).toEqual([
      403,
      "This key isn't locked to packs: connect to /mcp, which serves everything it may reach.",
    ])
    expect((await knock(app, '/mcp', refreshed.json.access_token)).status).toBe(200)
  })

  it('an app connected at /mcp/p/desk that sends that address as its resource signs in and refreshes as a root grant', async () => {
    const app = await withDesk()
    const { clientId, tokens } = await signInFor(app, 'http://localhost/mcp/p/desk')
    expect(decodeJwt(tokens.access_token).aud).toBe('http://localhost/mcp/p/desk')
    expect((await knock(app, '/api/calls', tokens.access_token)).status).toBe(200)
    expect((await knock(app, '/mcp', tokens.access_token)).status).toBe(200)
    const me = await app.request('/api/me', { headers: bearer(tokens.access_token) })
    expect(await me.json()).toMatchObject({ scope: 'write', upstreams: 'all', pack: null })
    const refreshed = await tokenFor(app, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: 'http://localhost/mcp/p/desk',
    })
    expect(refreshed.status).toBe(200)
    expect((await knock(app, '/api/calls', refreshed.json.access_token)).status).toBe(200)
  })

  it('with PUBLIC_HOST naming a reachable host, a pack sign-in is issued and checked under that origin', async () => {
    const app = await withDesk({ PUBLIC_HOST: 'gw.example.test' })
    const { tokens } = await signInFor(app, 'https://gw.example.test/p/desk/mcp')
    expect(decodeJwt(tokens.access_token)).toMatchObject({
      iss: 'https://gw.example.test',
      aud: 'https://gw.example.test/p/desk/mcp',
    })
    expect((await knock(app, '/p/desk/mcp', tokens.access_token)).status).toBe(200)
    const refused = await knock(app, '/mcp', tokens.access_token)
    expect([refused.status, await detailOf(refused)]).toEqual([
      401,
      'This sign-in opens Front desk only: connect at https://gw.example.test/p/desk/mcp.',
    ])
    // Links a tool hands out are under the gateway's own address, not the pack's: a pack's sign-in isn't taken there
    const link = await app.request('/u/sample/r/recipes/1', { headers: bearer(tokens.access_token) })
    expect([link.status, await detailOf(link)]).toEqual([
      401,
      'This sign-in opens Front desk only: connect at https://gw.example.test/p/desk/mcp.',
    ])
  })

  it('on the compose default, a token issued at one host name is refused at another by the sign-in’s issuer check', async () => {
    const app = await withDesk({ PUBLIC_HOST: 'http://localhost:8080' })
    for (const resource of ['http://localhost/p/desk/mcp', 'http://localhost/mcp']) {
      const { tokens } = await signInFor(app, resource)
      expect((await knock(app, '/p/desk/mcp', tokens.access_token)).status).not.toBe(401)
      const other = await knock(app, '/p/desk/mcp', tokens.access_token, { 'x-forwarded-host': '127.0.0.1' })
      expect([resource, other.status, await detailOf(other)]).toEqual([
        resource,
        401,
        expect.stringMatching(/^This token or API key is not valid/),
      ])
    }
  })

  it('a forged x-forwarded-host changes no document or check when PUBLIC_HOST names a reachable host', async () => {
    const app = await withDesk({ PUBLIC_HOST: 'gw.example.test' })
    const forged = { 'x-forwarded-host': 'evil.example.test', 'x-forwarded-proto': 'https' }
    const metadata = await app.request('/.well-known/oauth-protected-resource/p/desk/mcp', { headers: forged })
    expect(await metadata.json()).toMatchObject({
      resource: 'https://gw.example.test/p/desk/mcp',
      authorization_servers: ['https://gw.example.test'],
    })
    expect(metadata.headers.get('cache-control')).toBe('public, max-age=300')
    const server = await app.request('/.well-known/oauth-authorization-server', { headers: forged })
    expect(((await server.json()) as { issuer: string }).issuer).toBe('https://gw.example.test')
    const refused = await knock(app, '/p/desk/mcp', undefined, forged)
    expect(pointerOf(refused)).toBe('https://gw.example.test/.well-known/oauth-protected-resource/p/desk/mcp')
    // A sign-in asked for the forged host's address is refused before the owner is asked to approve it
    const browser = browserOn(app)
    await signInWithKey(browser)
    const client = await register(app)
    const asked = client.authorize.replace(
      encodeURIComponent('http://localhost/mcp'),
      encodeURIComponent('https://evil.example.test/p/desk/mcp'),
    )
    expect((await browser.send(asked, { headers: forged })).status).toBe(400)
  })

  it('with the compose default PUBLIC_HOST, metadata follows the request’s host as today', async () => {
    const app = await withDesk({ PUBLIC_HOST: 'http://localhost:8080' })
    const metadata = await app.request('/.well-known/oauth-protected-resource/p/desk/mcp', {
      headers: { 'x-forwarded-host': 'nas.example.test:8080' },
    })
    expect(((await metadata.json()) as { resource: string }).resource).toBe('http://nas.example.test:8080/p/desk/mcp')
    expect(metadata.headers.get('cache-control')).toBe('no-store')
  })
})

describe('the address a caller is counted by', () => {
  const register = (app: App, address?: string) =>
    app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(address ? { 'x-forwarded-for': address } : {}) },
      body: JSON.stringify({ client_name: 'Sample', redirect_uris: [REDIRECT] }),
    })
  const signInWith = (app: App, address: string) =>
    app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-forwarded-for': address },
      body: JSON.stringify({ key: 'not-the-owner-key' }),
    })

  it('is the one the proxy wrote, for the sign-in endpoints and the owner’s sign-in alike', async () => {
    const app = await gateway({ GATEWAY_ADDRESS_HEADER: 'x-forwarded-for' })
    // A caller's own value comes first; the proxy appends the address it saw
    for (let index = 0; index < 20; index++)
      expect((await register(app, `198.51.100.${index}, 203.0.113.1`)).status).toBe(201)
    expect((await register(app, '198.51.100.99, 203.0.113.1')).status).toBe(429)
    expect((await register(app, '203.0.113.2')).status).toBe(201)
    for (let index = 0; index < 10; index++) expect((await signInWith(app, '203.0.113.3')).status).not.toBe(429)
    expect((await signInWith(app, '203.0.113.3')).status).toBe(429)
    expect((await signInWith(app, '203.0.113.4')).status).not.toBe(429)
  })

  it('with no header named, says once that a proxy’s header was seen, and never with one named', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void lines.push(String(line)))
    const servers: ReturnType<typeof serve>[] = []
    const listen = async (app: App) => {
      const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
      servers.push(server)
      await new Promise<void>((resolve) => server.once('listening', () => resolve()))
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }
    try {
      const plain = await listen(await gateway())
      expect((await fetch(`${plain}/llms.txt`)).status).toBe(200)
      expect(lines).toEqual([])
      for (const address of ['203.0.113.7', '203.0.113.8'])
        await fetch(`${plain}/llms.txt`, { headers: { 'x-forwarded-for': address } })
      expect(lines).toEqual([
        'A proxy at 127.0.0.1 forwards requests (x-forwarded-for), but GATEWAY_ADDRESS_HEADER is empty: every caller counts as 127.0.0.1 and shares one sign-in and call limit, which anyone can use up. Set GATEWAY_ADDRESS_HEADER to the header your proxy writes (x-forwarded-for behind Caddy or nginx, cf-connecting-ip behind Cloudflare).',
      ])
      const named = await listen(await gateway({ GATEWAY_ADDRESS_HEADER: 'x-forwarded-for' }))
      await fetch(`${named}/llms.txt`, { headers: { 'x-forwarded-for': '203.0.113.7' } })
      expect(lines).toHaveLength(1)
    } finally {
      spy.mockRestore()
      for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
