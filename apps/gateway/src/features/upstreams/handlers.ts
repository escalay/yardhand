/** Upstream handlers: request → repo/sync → HAL. Credentials go into the vault and never come back out. */

import type { RouteHandler } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { COMPOSIO_MCP, COMPOSIO_REST } from '../../adapters/composio.js'
import type { Credential } from '../../adapters/index.js'
import { SAMPLE_URL } from '../../adapters/sample.js'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { allows, callerOf, type Principal, requireOwner, seenBy } from '../clients/principals.js'
import { connectionSecretOf } from '../connections/provider.js'
import { probeUpstream } from './probe.js'
import { PATH, type routes } from './routes.js'
import { secretIdOf, type UpstreamRow } from './schema.js'
import { endpointOf } from './sync.js'

type Routes = typeof routes
type AuthInput = { type: 'none' | 'bearer' | 'header' | 'basic' | 'oauth'; header?: string; value?: string }

/**
 * A Composio upstream's defaults: its address by mode, the header its key goes in, and links left as they are (its
 * API is account-wide, so the link proxy stays off).
 */
const withComposioDefaults = <
  T extends {
    kind: string
    url?: string | undefined
    auth: AuthInput
    linkProxy: boolean
    composio?: { mode: 'personal' | 'project' } | undefined
  },
>(
  input: T,
): T => {
  if (input.kind !== 'composio') return input
  if (!input.composio)
    throw new ProblemError('bad_request', {
      detail: 'A composio upstream needs composio.toolkits (e.g. ["gmail", "googlecalendar"]) and composio.mode.',
    })
  const personal = input.composio.mode === 'personal'
  return {
    ...input,
    url: input.url ?? (personal ? COMPOSIO_MCP : COMPOSIO_REST),
    auth:
      input.auth.type === 'header' && !input.auth.header
        ? { ...input.auth, header: personal ? 'x-consumer-api-key' : 'x-api-key' }
        : input.auth,
    linkProxy: false,
  }
}

const checkAuth = (auth: AuthInput) => {
  if (auth.type !== 'none' && auth.type !== 'oauth' && !auth.value)
    throw new ProblemError('bad_request', { detail: `auth.value is required for auth type ${auth.type}.` })
  if (auth.type === 'header' && !auth.header)
    throw new ProblemError('bad_request', { detail: 'auth.header names the header for auth type header.' })
}

export const upstreamsHandlers = (services: Services) => {
  const {
    upstreams,
    vault,
    sync,
    adapters,
    tools,
    catalog,
    clients,
    packs,
    principals,
    meaning,
    watcher,
    listsChanged,
  } = services
  const rowOf = async (id: string) => {
    const row = await upstreams.get(id)
    if (!row) throw new ProblemError('not_found', { detail: `No upstream ${id}. GET ${PATH} lists them.` })
    return row
  }
  type Offers = { manuals: number; playbooks: number; links: number }
  const NONE: Offers = { manuals: 0, playbooks: 0, links: 0 }
  /** Live manuals, playbooks and links per upstream. */
  const offersBy = async () => {
    const byUpstream = new Map<string, Offers>()
    for (const row of await catalog.counts()) {
      const offers = { ...(byUpstream.get(row.upstreamId) ?? NONE) }
      const key = row.kind === 'manual' ? 'manuals' : row.kind === 'playbook' ? 'playbooks' : 'links'
      offers[key] += Number(row.count)
      byUpstream.set(row.upstreamId, offers)
    }
    return (id: string) => byUpstream.get(id) ?? NONE
  }
  type GroupCount = { key: string; title: string; tools: number }
  /**
   * Each upstream's groups with the tools this caller is listed, biggest first and Other last. A pack key gets none:
   * its tools are the pack's, in the pack's own wording.
   */
  const groupsBy = async (principal: Principal, ids: string[]) => {
    const byUpstream = new Map<string, Map<string, GroupCount>>()
    if (!principal.pack && ids.length) {
      const seen = seenBy(principal)
      for (const tool of await tools.listLive({ upstreams: ids, limit: 5000 })) {
        if (!tool.group || !seen(tool)) continue
        const groups = byUpstream.get(tool.upstreamId) ?? new Map<string, GroupCount>()
        const group = groups.get(tool.group.key) ?? { ...tool.group, tools: 0 }
        groups.set(tool.group.key, { ...group, tools: group.tools + 1 })
        byUpstream.set(tool.upstreamId, groups)
      }
    }
    return (id: string) =>
      [...(byUpstream.get(id)?.values() ?? [])].sort(
        (a, b) => Number(a.key === 'other') - Number(b.key === 'other') || b.tools - a.tools,
      )
  }
  const cardOf = (origin: string, row: UpstreamRow, owner: boolean, offers: Offers, groups: GroupCount[]) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    url: owner ? row.url : null,
    http: owner && row.kind !== 'composio' && row.config ? JSON.parse(row.config) : null,
    composio: owner && row.kind === 'composio' && row.config ? JSON.parse(row.config) : null,
    auth: owner ? row.auth : null,
    trust: row.trust,
    enabled: row.enabled,
    status: row.status,
    toolCount: row.toolCount,
    groups,
    offers: owner || row.playbooks ? offers : { ...offers, playbooks: 0 },
    playbooks: row.playbooks,
    linkProxy: row.linkProxy,
    instructions: row.instructions,
    server: row.server,
    lastError: owner ? row.lastError : null,
    syncedAt: row.syncedAt,
    _links: linksOf(origin, { self: `${PATH}/${row.id}`, tools: `/api/tools?upstream=${row.id}`, list: PATH }),
  })
  const principalOf = (c: Context) => principals.require(callerOf(c))
  const storeAuth = async (id: string, auth: AuthInput) => {
    if (auth.type === 'none' || auth.type === 'oauth') await vault.remove(secretIdOf(id))
    else await vault.put(secretIdOf(id), { value: auth.value })
  }
  const syncQuietly = async (id: string) => sync(id).catch(() => null)

  const list: RouteHandler<Routes['list']> = async (c) => {
    const principal = await principalOf(c)
    const origin = originOf(c)
    const rows = (await upstreams.list()).filter((row) => allows(principal, row.id) && (principal.owner || row.enabled))
    const offersOf = await offersBy()
    const groupsOf = await groupsBy(
      principal,
      rows.map((row) => row.id),
    )
    return c.json(
      {
        count: rows.length,
        _links: linksOf(origin, { self: PATH }),
        _embedded: {
          upstreams: rows.map((row) => cardOf(origin, row, principal.owner, offersOf(row.id), groupsOf(row.id))),
        },
      },
      200,
    )
  }
  const get: RouteHandler<Routes['get']> = async (c) => {
    const principal = await principalOf(c)
    const { id } = c.req.valid('param')
    if (!allows(principal, id))
      throw new ProblemError('not_found', { detail: `No upstream ${id} for this client. GET ${PATH} lists yours.` })
    return c.json(
      cardOf(
        originOf(c),
        await rowOf(id),
        principal.owner,
        (await offersBy())(id),
        (await groupsBy(principal, [id]))(id),
      ),
      200,
    )
  }
  const create: RouteHandler<Routes['create']> = async (c) => {
    requireOwner(c)
    const given = withComposioDefaults(c.req.valid('json'))
    // The sample tools live in the gateway itself: no address, no key, nothing to review
    const input =
      given.kind === 'sample'
        ? { ...given, url: SAMPLE_URL, auth: { type: 'none' as const }, trust: 'trusted' as const, linkProxy: false }
        : given
    checkAuth(input.auth)
    if (!input.url)
      throw new ProblemError('bad_request', {
        detail: 'url is required (only composio and sample upstreams have a default).',
      })
    if (await upstreams.get(input.id))
      throw new ProblemError('conflict', {
        detail: `Upstream ${input.id} exists: PATCH ${PATH}/${input.id} changes it.`,
      })
    if (input.kind === 'http' && input.auth.type === 'oauth')
      throw new ProblemError('bad_request', {
        detail: 'OAuth connect is for MCP upstreams; give a REST upstream a key or header.',
      })
    if (input.kind === 'http' && !input.http?.spec && !input.http?.endpoints?.length)
      throw new ProblemError('bad_request', {
        detail: 'An http upstream needs http.spec (an OpenAPI document) or http.endpoints.',
      })
    await upstreams.create({
      config: input.composio ? JSON.stringify(input.composio) : input.http ? JSON.stringify(input.http) : null,
      id: input.id,
      title: input.title ?? input.id,
      kind: input.kind,
      url: input.url,
      auth: input.auth.type,
      authHeader: input.auth.header ?? null,
      trust: input.trust,
      enabled: input.enabled,
      linkProxy: input.linkProxy,
    })
    await storeAuth(input.id, input.auth)
    const summary = await syncQuietly(input.id)
    void watcher.restart(input.id)
    return c.json(
      {
        ...cardOf(
          originOf(c),
          await rowOf(input.id),
          true,
          (await offersBy())(input.id),
          (await groupsBy(await principalOf(c), [input.id]))(input.id),
        ),
        sync: summary,
      },
      201,
      {
        location: `${PATH}/${input.id}`,
      },
    )
  }
  const update: RouteHandler<Routes['update']> = async (c) => {
    requireOwner(c)
    const { id } = c.req.valid('param')
    const row = await rowOf(id)
    const change = c.req.valid('json')
    if (change.composio && row.kind !== 'composio')
      throw new ProblemError('bad_request', {
        detail: `${id} is an ${row.kind} upstream: composio is for Composio ones.`,
      })
    if (change.auth) checkAuth(change.auth)
    await upstreams.update(id, {
      ...(change.title === undefined ? {} : { title: change.title }),
      ...(change.url === undefined ? {} : { url: change.url }),
      ...(change.http === undefined ? {} : { config: JSON.stringify(change.http) }),
      ...(change.composio === undefined ? {} : { config: JSON.stringify(change.composio) }),
      ...(change.trust === undefined ? {} : { trust: change.trust }),
      ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
      ...(change.playbooks === undefined ? {} : { playbooks: change.playbooks }),
      ...(change.linkProxy === undefined ? {} : { linkProxy: change.linkProxy }),
      ...(change.auth === undefined ? {} : { auth: change.auth.type, authHeader: change.auth.header ?? null }),
    })
    if (change.auth) await storeAuth(id, change.auth)
    // A new title changes what its tools are about for search
    if (change.title !== undefined) void meaning?.refresh()
    if (change.url || change.auth || change.http || change.composio) {
      await adapters.forget(id)
      await syncQuietly(id)
    }
    if (change.enabled !== undefined || change.playbooks !== undefined || change.title !== undefined) listsChanged()
    // Listening follows the address, the key and the switch
    if (change.enabled === false) await watcher.stop(id)
    else if (change.url || change.auth || change.enabled) await watcher.restart(id)
    return c.json(
      cardOf(
        originOf(c),
        await rowOf(id),
        true,
        (await offersBy())(id),
        (await groupsBy(await principalOf(c), [id]))(id),
      ),
      200,
    )
  }
  const remove: RouteHandler<Routes['remove']> = async (c) => {
    requireOwner(c)
    const { id } = c.req.valid('param')
    await rowOf(id)
    await adapters.forget(id)
    await watcher.stop(id)
    const offered = (await catalog.listLive({ kinds: ['manual', 'playbook'], upstreams: [id] })).map((item) => ({
      kind: item.kind as 'manual' | 'playbook',
      name: item.name,
    }))
    await clients.forgetUpstream(id)
    await packs.forgetUpstream(id, offered)
    await tools.removeUpstream(id)
    await catalog.removeUpstream(id)
    await vault.remove(secretIdOf(id))
    // An OAuth upstream also leaves its client registration and tokens
    await vault.remove(connectionSecretOf(id))
    await upstreams.remove(id)
    listsChanged()
    return c.body(null, 204)
  }
  const accounts: RouteHandler<Routes['accounts']> = async (c) => {
    requireOwner(c)
    const { id } = c.req.valid('param')
    const row = await rowOf(id)
    const adapter = adapters.for(row.kind)
    if (!adapter.accounts)
      throw new ProblemError('not_found', {
        detail: `${id} is an ${row.kind} upstream: only Composio upstreams hold accounts.`,
      })
    const found = await adapter.accounts(endpointOf(row), await vault.get<Credential>(secretIdOf(id)))
    return c.json(
      {
        count: found.length,
        _links: linksOf(originOf(c), { self: `${PATH}/${id}/accounts`, upstream: `${PATH}/${id}` }),
        _embedded: { accounts: found },
      },
      200,
    )
  }
  const syncOne: RouteHandler<Routes['sync']> = async (c) => {
    requireOwner(c)
    const { id } = c.req.valid('param')
    await rowOf(id)
    return c.json(await sync(id), 200)
  }
  const probe: RouteHandler<Routes['probe']> = async (c) => {
    requireOwner(c)
    const { url, auth } = c.req.valid('json')
    const taken = new Set((await upstreams.list()).map((row) => row.id))
    const found = await probeUpstream({ adapters, url, auth, taken })
    return c.json({ ...found, _links: linksOf(originOf(c), { self: `${PATH}/probe`, create: PATH }) }, 200)
  }
  return { list, get, create, update, remove, sync: syncOne, accounts, probe }
}
