/**
 * A pack's people (owner only): everyone it is shared with, and sharing it with one more. A person is a client that
 * opens the pack; Extend and Revoke are the client's own routes.
 */
import type { RouteHandler } from '@hono/zod-openapi'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { expiryOf, standingOf } from '../clients/lifetimes.js'
import { requireOwner } from '../clients/principals.js'
import type { ClientRow } from '../clients/schema.js'
import { noPack } from './names.js'
import { PATH, type routes } from './routes.js'
import type { PackRow } from './schema.js'
import { shareMessage } from './share.js'

type Routes = typeof routes

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** The clients People lists, of those that open a pack: all but the revoked and those that ended over 30 days ago. */
export const listedOf = <Row extends Pick<ClientRow, 'createdAt' | 'expiresAt' | 'revokedAt'>>(
  rows: Row[],
  now = new Date(),
) => rows.filter((row) => standingOf(row, now) !== 'gone')

export const peopleHandlers = ({ packs, clients, calls, principals, listsChanged }: Services) => {
  const packOf = async (name: string) => {
    const pack = await packs.get(name)
    if (!pack) throw new ProblemError('not_found', { detail: await noPack(packs, name) })
    return pack
  }

  /** What the rows of one pack are read against: each client's calls, the old address it came by, every pack's name. */
  const factsOf = async (pack: PackRow, now: Date) => {
    const [week, last, notes, all] = await Promise.all([
      calls.byClient(new Date(now.getTime() - WEEK_MS).toISOString()),
      calls.lastByClient(),
      clients.cameBy(pack.id),
      packs.list(),
    ])
    return {
      now,
      calls7d: new Map(week.map((row) => [row.clientId, Number(row.count)])),
      lastAt: new Map(last.map((row) => [row.clientId, row.lastAt])),
      cameBy: new Map(notes.map((note) => [note.clientId, note])),
      names: new Map(all.map((other) => [other.id, other.name])),
    }
  }

  const personOf = async (
    origin: string,
    pack: PackRow,
    row: ClientRow,
    facts: Awaited<ReturnType<typeof factsOf>>,
  ) => {
    const standing = standingOf(row, facts.now)
    const note = facts.cameBy.get(row.id)
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      app: row.app,
      scope: row.scope,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      ending: standing === 'ending',
      ended: standing === 'ended',
      lastCallAt: facts.lastAt.get(row.id) ?? null,
      calls7d: facts.calls7d.get(row.id) ?? 0,
      otherPacks: (await clients.packsOf(row))
        .filter((packId) => packId !== pack.id)
        .flatMap((packId) => facts.names.get(packId) ?? []),
      oldAddress: note?.cameBy && note.cameByAt ? { name: note.cameBy, lastAt: note.cameByAt } : null,
      _links: linksOf(origin, {
        self: `/api/clients/${row.id}`,
        calls: `/api/calls?client=${row.id}`,
        pack: `${PATH}/${pack.name}`,
      }),
    }
  }

  const people: RouteHandler<Routes['people']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    const origin = originOf(c)
    const facts = await factsOf(pack, new Date())
    const rows = await Promise.all(
      listedOf(await clients.ofPack(pack.id), facts.now).map((row) => personOf(origin, pack, row, facts)),
    )
    // Who can use it first, oldest first; whose access ended last
    const listed = rows.sort(
      (a, b) => Number(a.ended) - Number(b.ended) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
    return c.json(
      {
        count: listed.length,
        _links: linksOf(origin, { self: `${PATH}/${pack.name}/people`, pack: `${PATH}/${pack.name}` }),
        _embedded: { people: listed },
      },
      200,
    )
  }

  const share: RouteHandler<Routes['share']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    const { name, app, scope, expiresIn } = c.req.valid('json')
    if (!(await packs.contentsOf(pack)).tools.length)
      throw new ProblemError('conflict', {
        detail: `${pack.title} holds no tools yet, so a key to it would reach nothing: add tools first.`,
      })
    const { id, key } = await principals.issue({
      name,
      app: app ?? null,
      scope,
      upstreams: [],
      packIds: [pack.id],
      packId: pack.id,
      expiresAt: expiryOf(expiresIn),
    })
    // The pack counts one more person: an open app reads it again
    listsChanged()
    const row = await clients.get(id)
    if (!row) throw new ProblemError('not_found', { detail: `No client ${id}. GET /api/clients lists them.` })
    const origin = originOf(c)
    const person = await personOf(origin, pack, row, await factsOf(pack, new Date()))
    const message = shareMessage({ pack, person: name, scope, expiresAt: row.expiresAt, app: row.app, origin, key })
    return c.json({ ...person, key, message }, 201, { location: `/api/clients/${id}` })
  }

  return { people, share }
}
