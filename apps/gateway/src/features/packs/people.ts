/**
 * A pack's people (owner only): everyone it is shared with, sharing it with one more, and each one's own values of
 * the variables its Per person inputs read. A person is a client that opens the pack; Extend and Revoke are the
 * client's own routes.
 */
import type { RouteHandler } from '@hono/zod-openapi'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { expiryOf, standingOf } from '../clients/lifetimes.js'
import { requireOwner } from '../clients/principals.js'
import type { ClientRow } from '../clients/schema.js'
import { perPersonOf, personValueProblems, throwOnRefused, variableKindOf } from './checks.js'
import { readersOf } from './entries.js'
import { noPack } from './names.js'
import { PATH, type routes } from './routes.js'
import type { PackRow } from './schema.js'
import { shareMessage } from './share.js'
import { type PackState, packStateOf } from './state.js'
import type { Scalar, Variables } from './values.js'

type Routes = typeof routes

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** The clients People lists, of those that open a pack: all but the revoked and those that ended over 30 days ago. */
export const listedOf = <Row extends Pick<ClientRow, 'createdAt' | 'expiresAt' | 'revokedAt'>>(
  rows: Row[],
  now = new Date(),
) => rows.filter((row) => standingOf(row, now) !== 'gone')

/** Only what a Per person input reads now: a value left from before the owner changed a mode is not theirs to show. */
const ownValuesOf = (values: Variables, state: PackState): Variables =>
  Object.fromEntries(Object.entries(values).filter(([name]) => perPersonOf(state, name)))

export const peopleHandlers = ({
  packs,
  tools,
  catalog,
  upstreams,
  clients,
  calls,
  principals,
  listsChanged,
  statedOrigin,
}: Services) => {
  const repos = { packs, tools, catalog, upstreams }
  const packOf = async (name: string) => {
    const pack = await packs.get(name)
    if (!pack) throw new ProblemError('not_found', { detail: await noPack(packs, name) })
    return pack
  }

  /** What the rows of one pack are read against: each client's calls, the old address it came by, every pack's name. */
  const factsOf = async (pack: PackRow, now: Date) => {
    const [week, last, notes, all, values, state] = await Promise.all([
      calls.byClient(new Date(now.getTime() - WEEK_MS).toISOString()),
      calls.lastByClient(),
      clients.cameBy(pack.id),
      packs.list(),
      packs.personValuesIn(pack.id),
      packStateOf(repos, pack),
    ])
    return {
      now,
      values: new Map([...values].map(([clientId, own]) => [clientId, ownValuesOf(own, state)])),
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
      values: facts.values.get(row.id) ?? {},
      _links: linksOf(origin, {
        self: `/api/clients/${row.id}`,
        calls: `/api/calls?client=${row.id}`,
        pack: `${PATH}/${pack.name}`,
        values: `${PATH}/${pack.name}/people/${row.id}/values`,
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
    const { name, app, scope, expiresIn, values } = c.req.valid('json')
    const state = await packStateOf(repos, pack)
    if (!state.tools.length)
      throw new ProblemError('conflict', {
        detail: `${pack.title} holds no tools yet, so a key to it would reach nothing: add tools first.`,
      })
    // Checked before the key is made: a refused share leaves no key behind
    throwOnRefused(personValueProblems(state, values ?? {}))
    const { id, key } = await principals.issue({
      name,
      app: app ?? null,
      scope,
      upstreams: [],
      packIds: [pack.id],
      packId: pack.id,
      expiresAt: expiryOf(expiresIn),
    })
    if (values && Object.keys(values).length) await packs.setPersonValues(pack.id, id, values)
    // The pack counts one more person: an open app reads it again
    listsChanged()
    const row = await clients.get(id)
    if (!row) throw new ProblemError('not_found', { detail: `No client ${id}. GET /api/clients lists them.` })
    const origin = originOf(c)
    const person = await personOf(origin, pack, row, await factsOf(pack, new Date()))
    const message = shareMessage({
      pack,
      person: name,
      scope,
      expiresAt: row.expiresAt,
      app: row.app,
      // Sent to someone else: the address set for people, not the one the owner happens to ask by
      origin: statedOrigin ?? origin,
      key,
    })
    return c.json({ ...person, key, message }, 201, { location: `/api/clients/${id}` })
  }

  /** A person of the pack by client id: one that opens it and is not revoked; 404 for anyone else. */
  const personIn = async (pack: PackRow, id: string) => {
    const row = (await clients.ofPack(pack.id)).find((client) => client.id === id)
    if (!row)
      throw new ProblemError('not_found', {
        detail: `No one with the client id ${id} has ${pack.title}. GET ${PATH}/${pack.name}/people lists them.`,
      })
    return row
  }

  const valuesOf = async (origin: string, pack: PackRow, row: ClientRow) => {
    const state = await packStateOf(repos, pack)
    const own = await packs.personValuesOf(pack.id, row.id)
    return {
      client: row.id,
      name: row.name,
      values: state.variables
        .filter((variable) => perPersonOf(state, variable.name))
        .map((variable) => ({
          name: variable.name,
          description: variable.description,
          value: Object.hasOwn(own, variable.name) ? (own[variable.name] as Scalar) : null,
          packValue: variable.value,
          kind: variableKindOf(state, variable),
          usedBy: state.tools.filter((tool) => readersOf(tool.person, variable.name).length).map((tool) => tool.name),
        })),
      _links: linksOf(origin, {
        self: `${PATH}/${pack.name}/people/${row.id}/values`,
        people: `${PATH}/${pack.name}/people`,
        pack: `${PATH}/${pack.name}`,
      }),
    }
  }

  const personValues: RouteHandler<Routes['personValues']> = async (c) => {
    requireOwner(c)
    const { name, client } = c.req.valid('param')
    const pack = await packOf(name)
    return c.json(await valuesOf(originOf(c), pack, await personIn(pack, client)), 200)
  }

  const setPersonValues: RouteHandler<Routes['setPersonValues']> = async (c) => {
    requireOwner(c)
    const { name, client } = c.req.valid('param')
    const pack = await packOf(name)
    const row = await personIn(pack, client)
    const { values } = c.req.valid('json')
    throwOnRefused(personValueProblems(await packStateOf(repos, pack), values))
    await packs.setPersonValues(
      pack.id,
      row.id,
      Object.fromEntries(Object.entries(values).flatMap(([key, value]) => (value === null ? [] : [[key, value]]))),
    )
    // Their tools read differently from their next call, and their playbooks and skill too
    listsChanged({ tools: true, prompts: true, resources: true })
    return c.json(await valuesOf(originOf(c), pack, row), 200)
  }

  return { people, share, personValues, setPersonValues }
}
