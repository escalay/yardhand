/** Client handlers: a new key is shown once; only its hash is kept (`principals.issue`). */
import type { RouteHandler } from '@hono/zod-openapi'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { noPack } from '../packs/names.js'
import { findability } from '../searches/demand.js'
import { needsWrite } from '../tools/repo.js'
import { expiryOf } from './lifetimes.js'
import { callerOf, describe, entryOf, pinnedBy, requireOwner } from './principals.js'
import { ME_PATH, PATH, PINS_PATH, type routes } from './routes.js'
import type { ClientRow } from './schema.js'
import { KEY_PLACEHOLDER, surfacesOf } from './setup.js'

type Routes = typeof routes

export const clientsHandlers = ({
  clients,
  principals,
  tools,
  calls,
  searches,
  env,
  packs,
  listsChanged,
  oauth,
}: Services) => {
  const rowOf = async (id: string) => {
    const row = await clients.get(id)
    if (!row) throw new ProblemError('not_found', { detail: `No client ${id}. GET ${PATH} lists them.` })
    return row
  }
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  type Usage = {
    calls7d: Map<string, number>
    lastAt: Map<string, string>
    found: Awaited<ReturnType<typeof findability>>['of']
  }
  const usageOf = async (): Promise<Usage> => {
    const since = new Date(Date.now() - WEEK_MS).toISOString()
    const [week, last, found] = await Promise.all([
      calls.byClient(since),
      calls.lastByClient(),
      findability({ searches, calls }, since),
    ])
    return {
      calls7d: new Map(week.map((row) => [row.clientId, Number(row.count)])),
      lastAt: new Map(last.map((row) => [row.clientId, row.lastAt])),
      found: found.of,
    }
  }
  const packNames = async () => new Map((await packs.list()).map((pack) => [pack.id, pack.name]))
  /** Packs by name, in order, and the default among them (`preferred`, else the first); 400 for one that isn't. */
  const packsNamed = async (names: string[], preferred: string | undefined) => {
    if (!names.length) return null
    const found = await Promise.all([...new Set(names)].map(async (name) => ({ name, pack: await packs.get(name) })))
    const missing = found.filter((item) => !item.pack).map((item) => item.name)
    if (missing.length)
      throw new ProblemError('bad_request', {
        detail: (await Promise.all(missing.map((name) => noPack(packs, name)))).join(' '),
      })
    const fallback = preferred ?? names[0]
    const defaultPack = found.find((item) => item.name === fallback)?.pack
    if (!defaultPack)
      throw new ProblemError('bad_request', {
        detail: `The default pack ${fallback} must be one of the key’s packs (${names.join(', ')}).`,
      })
    return { ids: found.flatMap((item) => (item.pack ? [item.pack.id] : [])), defaultId: defaultPack.id }
  }
  const cardOf = async (origin: string, row: ClientRow, usage?: Usage, names?: Map<string, string>) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    oauthClientId: row.oauthClientId,
    scope: row.scope,
    upstreams: await clients.upstreamsOf(row),
    pins: row.ownPins ? await clients.pinsOf(row.id) : null,
    macTools: row.macTools,
    resultCap: row.resultCap,
    pack: row.packId ? ((names ?? (await packNames())).get(row.packId) ?? null) : null,
    packs: await (async () => {
      const known = names ?? (await packNames())
      const ids = await clients.packsOf(row)
      const ordered = [...ids].sort((a, b) => Number(b === row.packId) - Number(a === row.packId))
      return ordered.flatMap((id) => known.get(id) ?? [])
    })(),
    expiresAt: row.expiresAt,
    app: row.app,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    usage: await (async () => {
      const known = usage ?? (await usageOf())
      const searched = known.found(row.id)
      return {
        calls7d: known.calls7d.get(row.id) ?? 0,
        lastCallAt: known.lastAt.get(row.id) ?? null,
        searches7d: searched.searches,
        found7d: searched.found,
      }
    })(),
    _links: linksOf(origin, {
      self: `${PATH}/${row.id}`,
      setup: `${PATH}/${row.id}/setup`,
      calls: `/api/calls?client=${row.id}`,
      list: PATH,
    }),
  })
  /** Throws 400 naming the pins a pack key's packs don't hold: a pin there is the pack's name for a tool. */
  const checkPackPins = async (names: string[] | null | undefined, packIds: string[]) => {
    if (!names?.length) return
    const held = new Set(
      (
        await Promise.all(
          packIds.map(async (id) => {
            const pack = await packs.byId(id)
            return pack ? (await packs.contentsOf(pack)).tools.map((tool) => tool.name) : []
          }),
        )
      ).flat(),
    )
    const missing = names.filter((name) => !held.has(name))
    if (missing.length)
      throw new ProblemError('bad_request', {
        detail: `Not a name in this key's packs: ${missing.join(', ')}. GET /api/packs/{name} lists a pack's names.`,
      })
  }
  const checkTools = async (names: string[] | null | undefined) => {
    if (!names?.length) return
    const found = new Set((await tools.liveMany(names)).map((tool) => tool.name))
    const missing = names.filter((name) => !found.has(name))
    if (missing.length)
      throw new ProblemError('bad_request', {
        detail: `Unknown or not live: ${missing.join(', ')}. GET /api/tools lists tools.`,
      })
  }

  /** The packs and default a change asks for; 409 for a key that isn't locked to packs. */
  const repackedOf = async (row: ClientRow, packNamesIn: string[] | undefined, packName: string | undefined) => {
    if (!row.packId)
      throw new ProblemError('conflict', {
        detail: `${row.name} isn't locked to packs, so it can't take one: make a pack key instead.`,
      })
    const current = await packNames()
    const names = packNamesIn ?? (await clients.packsOf(row)).flatMap((packId) => current.get(packId) ?? [])
    return packsNamed(names, packName ?? (packNamesIn ? undefined : current.get(row.packId)))
  }

  const me: RouteHandler<Routes['me']> = async (c) => {
    const principal = await principals.require(callerOf(c))
    const { pack } = principal
    // Each pin is a name the caller calls (in a pack, the pack's own), shown as it reads the tool behind it
    const pinned = [...new Set(pinnedBy(principal, await clients.globalPins()))].flatMap((name) => {
      const entry = entryOf(principal, name)
      return entry ? [{ name, tool: entry.tool }] : []
    })
    const live = new Map((await tools.liveMany(pinned.map((pin) => pin.tool))).map((tool) => [tool.name, tool]))
    // A read-only pack key doesn't list what it can't run
    const allowed = pinned.flatMap(({ name, tool: toolName }) => {
      const tool = live.get(toolName)
      const usable =
        tool &&
        tool.access !== 'off' &&
        (principal.upstreams === 'all' || principal.upstreams.includes(tool.upstreamId)) &&
        !(pack && principal.scope === 'read' && needsWrite(tool))
      return usable ? [describe(principal, tool, name)] : []
    })
    return c.json(
      {
        id: principal.id,
        name: principal.name,
        owner: principal.owner,
        scope: principal.scope,
        upstreams: principal.upstreams,
        pins: allowed.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        })),
        resultCap: principal.resultCap,
        packs: principal.packs.map((opened, index) => ({
          ...opened,
          mcpUrl: `${originOf(c)}/p/${opened.name}/mcp`,
          default: index === 0,
        })),
        pack: pack
          ? {
              name: pack.name,
              title: pack.title,
              description: pack.description,
              playbooks: [...pack.playbooks],
              manuals: [...pack.manuals],
              ownPlaybooks: [...pack.ownPlaybooks],
              skill: pack.skill,
              ownPins: principal.pins !== null,
            }
          : null,
        _links: linksOf(originOf(c), { self: ME_PATH, tools: '/api/tools', upstreams: '/api/upstreams' }),
      },
      200,
    )
  }
  const list: RouteHandler<Routes['list']> = async (c) => {
    requireOwner(c)
    const origin = originOf(c)
    const rows = await clients.list()
    const usage = await usageOf()
    const names = await packNames()
    return c.json(
      {
        count: rows.length,
        _links: linksOf(origin, { self: PATH }),
        _embedded: { clients: await Promise.all(rows.map((row) => cardOf(origin, row, usage, names))) },
      },
      200,
    )
  }
  const get: RouteHandler<Routes['get']> = async (c) => {
    requireOwner(c)
    return c.json(await cardOf(originOf(c), await rowOf(c.req.valid('param').id)), 200)
  }
  const create: RouteHandler<Routes['create']> = async (c) => {
    requireOwner(c)
    const { pack: packName, packs: packNamesIn, expiresIn, ...input } = c.req.valid('json')
    const chosen = await packsNamed(packNamesIn ?? (packName ? [packName] : []), packName)
    if (!chosen && !input.upstreams)
      throw new ProblemError('bad_request', {
        detail: 'Say which upstreams it reaches (`all` or ids), or give a pack.',
      })
    await (chosen ? checkPackPins(input.pins, chosen.ids) : checkTools(input.pins))
    const { id, key } = await principals.issue({
      ...input,
      upstreams: chosen ? [] : (input.upstreams ?? []),
      packIds: chosen?.ids ?? [],
      packId: chosen?.defaultId ?? null,
      expiresAt: expiryOf(expiresIn),
    })
    return c.json({ ...(await cardOf(originOf(c), await rowOf(id))), key }, 201, { location: `${PATH}/${id}` })
  }
  const update: RouteHandler<Routes['update']> = async (c) => {
    requireOwner(c)
    const { id } = c.req.valid('param')
    const row = await rowOf(id)
    if (row.revokedAt) throw new ProblemError('gone', { detail: `Client ${id} was revoked; make a new one.` })
    const { packs: packNamesIn, pack: packName, expiresIn, ...change } = c.req.valid('json')
    const repacked = packNamesIn || packName ? await repackedOf(row, packNamesIn, packName) : null
    // Extending a pack key none of whose packs is left would open nothing
    if (expiresIn && row.packId && !repacked) {
      const left = await Promise.all((await clients.packsOf(row)).map((packId) => packs.byId(packId)))
      if (!left.some(Boolean))
        throw new ProblemError('conflict', {
          detail: `${row.name}’s pack was removed, so extending the key would open nothing: make a new key, or give this one a pack with PATCH ${PATH}/${id} {"packs":["<name>"],"expiresIn":"${expiresIn}"}.`,
        })
    }
    // A pack key's pins are checked against the packs this change leaves it with
    await (row.packId
      ? checkPackPins(change.pins, repacked?.ids ?? (await clients.packsOf(row)))
      : checkTools(change.pins))
    if (repacked) {
      await clients.setPacks(id, repacked.ids, repacked.defaultId)
      // Its own values go with a pack it no longer opens
      await packs.forgetPerson(id, repacked.ids)
    }
    // Extend counts from now; a change that says nothing of it leaves the end where it was
    await clients.update(id, expiresIn ? { ...change, expiresAt: expiryOf(expiresIn) } : change)
    // Its allowlist, scope or pins change what it sees
    listsChanged()
    return c.json(await cardOf(originOf(c), await rowOf(id)), 200)
  }
  const revoke: RouteHandler<Routes['revoke']> = async (c) => {
    requireOwner(c)
    const row = await rowOf(c.req.valid('param').id)
    await clients.revoke(row.id)
    await packs.forgetPerson(row.id)
    principals.dropKey(row.keyHash)
    // Ends each of the row's sign-ins at the kit, never the app's registration
    for (const grant of await clients.grantsOf(row.id)) await oauth.current?.revokeGrant(grant)
    return c.body(null, 204)
  }
  const setup: RouteHandler<Routes['setup']> = async (c) => {
    requireOwner(c)
    const row = await rowOf(c.req.valid('param').id)
    const origin = originOf(c)
    return c.json(
      {
        client: row.id,
        mcpUrl: `${origin}/mcp`,
        apiUrl: `${origin}/api`,
        keyPlaceholder: KEY_PLACEHOLDER,
        surfaces: surfacesOf({
          origin,
          kind: row.kind,
          oauth: Boolean(env.OAUTH_SIGNING_KEY),
          packs: (await cardOf(origin, row)).packs,
        }),
        _links: linksOf(origin, { self: `${PATH}/${row.id}/setup`, client: `${PATH}/${row.id}` }),
      },
      200,
    )
  }
  const getPins: RouteHandler<Routes['getPins']> = async (c) => {
    requireOwner(c)
    return c.json({ tools: await clients.globalPins(), _links: linksOf(originOf(c), { self: PINS_PATH }) }, 200)
  }
  const setPins: RouteHandler<Routes['setPins']> = async (c) => {
    requireOwner(c)
    const { tools: names } = c.req.valid('json')
    await checkTools(names)
    await clients.setGlobalPins(names)
    listsChanged({ tools: true })
    return c.json({ tools: await clients.globalPins(), _links: linksOf(originOf(c), { self: PINS_PATH }) }, 200)
  }
  return { me, list, get, create, update, revoke, setup, getPins, setPins }
}
