/** Client handlers: keys are minted here and shown once; only their hashes are kept. */
import type { RouteHandler } from '@hono/zod-openapi'
import { linksOf, mintApiKey, originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { findability } from '../searches/demand.js'
import { needsWrite } from '../tools/repo.js'
import { callerOf, requireOwner, shownAs } from './principals.js'
import { ME_PATH, PATH, PINS_PATH, type routes } from './routes.js'
import type { ClientRow } from './schema.js'
import { KEY_PLACEHOLDER, surfacesOf } from './setup.js'

type Routes = typeof routes

const LIFETIME_MS = { '8h': 8 * 3_600_000, '1d': 24 * 3_600_000, '7d': 7 * 24 * 3_600_000 } as const

export const clientsHandlers = ({
  clients,
  principals,
  tools,
  calls,
  searches,
  env,
  packs,
  listsChanged,
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
      throw new ProblemError('bad_request', { detail: `No pack ${missing.join(', ')}. GET /api/packs lists them.` })
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
  const checkTools = async (names: string[] | null | undefined) => {
    if (!names?.length) return
    const found = new Set((await tools.liveMany(names)).map((tool) => tool.name))
    const missing = names.filter((name) => !found.has(name))
    if (missing.length)
      throw new ProblemError('bad_request', {
        detail: `Unknown or not live: ${missing.join(', ')}. GET /api/tools lists tools.`,
      })
  }

  const me: RouteHandler<Routes['me']> = async (c) => {
    const principal = await principals.require(callerOf(c))
    const { pack } = principal
    // A pack key's pins are its pack, each under the pack's name for it; a read-only one doesn't list what it can't run
    const wanted = pack ? [...new Set([...pack.tools.values()].map((entry) => entry.tool))] : null
    const pinned = await tools.liveMany(wanted ?? principal.pins ?? (await clients.globalPins()))
    const usable = pinned.filter(
      (tool) =>
        tool.access !== 'off' &&
        (principal.upstreams === 'all' || principal.upstreams.includes(tool.upstreamId)) &&
        !(pack && principal.scope === 'read' && needsWrite(tool)),
    )
    const shown = usable.flatMap((tool) => shownAs(principal, tool))
    const order = pack ? [...pack.tools.keys()] : []
    const allowed = pack ? shown.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)) : shown
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
          mcpUrl: `${originOf(c)}/mcp/p/${opened.name}`,
          default: index === 0,
        })),
        pack: pack
          ? {
              name: pack.name,
              title: pack.title,
              description: pack.description,
              playbooks: [...pack.playbooks],
              manuals: [...pack.manuals],
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
    await checkTools(input.pins)
    const { key, hash } = mintApiKey('gw')
    const id = await clients.create({
      ...input,
      upstreams: chosen ? [] : (input.upstreams ?? []),
      pins: chosen ? null : input.pins,
      kind: 'key',
      keyHash: hash,
      packIds: chosen?.ids ?? [],
      packId: chosen?.defaultId ?? null,
      expiresAt:
        !expiresIn || expiresIn === 'never' ? null : new Date(Date.now() + LIFETIME_MS[expiresIn]).toISOString(),
    })
    principals.addKey(hash, id)
    return c.json({ ...(await cardOf(originOf(c), await rowOf(id))), key }, 201, { location: `${PATH}/${id}` })
  }
  const update: RouteHandler<Routes['update']> = async (c) => {
    requireOwner(c)
    const { id } = c.req.valid('param')
    const row = await rowOf(id)
    if (row.revokedAt) throw new ProblemError('gone', { detail: `Client ${id} was revoked; make a new one.` })
    const { packs: packNamesIn, pack: packName, ...change } = c.req.valid('json')
    await checkTools(change.pins)
    if (packNamesIn || packName) {
      if (!row.packId)
        throw new ProblemError('conflict', {
          detail: `${row.name} isn't locked to packs, so it can't take one: make a pack key instead.`,
        })
      const current = await packNames()
      const names = packNamesIn ?? (await clients.packsOf(row)).flatMap((packId) => current.get(packId) ?? [])
      const chosen = await packsNamed(names, packName ?? (packNamesIn ? undefined : current.get(row.packId)))
      if (chosen) await clients.setPacks(id, chosen.ids, chosen.defaultId)
    }
    await clients.update(id, change)
    // Its allowlist, scope or pins change what it sees
    listsChanged()
    return c.json(await cardOf(originOf(c), await rowOf(id)), 200)
  }
  const revoke: RouteHandler<Routes['revoke']> = async (c) => {
    requireOwner(c)
    const row = await rowOf(c.req.valid('param').id)
    await clients.revoke(row.id)
    principals.dropKey(row.keyHash)
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
