/** Clients, their allowlists and pins: the only queries on these tables. */
import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, isNull, like } from 'drizzle-orm'
import type { Db } from '../../kit/index.js'
import {
  type ClientRow,
  clientPacks,
  clients,
  clientUpstreams,
  DEFAULT_RESULT_CAP,
  GLOBAL_PINS,
  pins,
} from './schema.js'

export type ClientDraft = {
  name: string
  kind: 'key' | 'oauth'
  keyHash?: string
  oauthName?: string
  scope: 'read' | 'write'
  upstreams: 'all' | string[]
  pins?: string[] | null
  macTools?: boolean
  resultCap?: number
  /** The packs it opens, the first being its default unless `packId` says otherwise. */
  packIds?: string[]
  packId?: string | null
  expiresAt?: string | null
}

export type ClientChange = Partial<
  Pick<ClientDraft, 'name' | 'scope' | 'upstreams' | 'pins' | 'macTools' | 'resultCap'>
>

export const clientsRepo = (db: Db) => {
  const setUpstreams = async (clientId: string, upstreams: 'all' | string[]) => {
    await db.delete(clientUpstreams).where(eq(clientUpstreams.clientId, clientId))
    if (upstreams !== 'all' && upstreams.length)
      await db.insert(clientUpstreams).values(upstreams.map((upstreamId) => ({ clientId, upstreamId })))
  }
  const setPins = async (clientId: string, toolNames: string[]) => {
    await db.delete(pins).where(eq(pins.clientId, clientId))
    if (toolNames.length)
      await db.insert(pins).values(toolNames.map((toolName, position) => ({ clientId, toolName, position })))
  }
  const setPacks = async (clientId: string, packIds: string[]) => {
    await db.delete(clientPacks).where(eq(clientPacks.clientId, clientId))
    if (packIds.length)
      await db.insert(clientPacks).values(packIds.map((packId, position) => ({ clientId, packId, position })))
  }
  /** The packs a key opens, in order; a key from before lists stays on its one pack. */
  const packsOf = async (row: Pick<ClientRow, 'id' | 'packId'>) => {
    const ids = (
      await db.select().from(clientPacks).where(eq(clientPacks.clientId, row.id)).orderBy(asc(clientPacks.position))
    ).map((link) => link.packId)
    return ids.length ? ids : row.packId ? [row.packId] : []
  }
  /** Every client (live or revoked) that opens this pack. */
  const idsOfPack = async (packId: string) =>
    (await db.select({ clientId: clientPacks.clientId }).from(clientPacks).where(eq(clientPacks.packId, packId))).map(
      (link) => link.clientId,
    )
  const pinsOf = async (clientId: string) =>
    (await db.select().from(pins).where(eq(pins.clientId, clientId)).orderBy(asc(pins.position))).map(
      (row) => row.toolName,
    )
  const upstreamsOf = async (row: ClientRow): Promise<'all' | string[]> =>
    row.allUpstreams
      ? 'all'
      : (await db.select().from(clientUpstreams).where(eq(clientUpstreams.clientId, row.id))).map(
          (link) => link.upstreamId,
        )

  return {
    list: () => db.select().from(clients).orderBy(asc(clients.createdAt)),
    get: async (id: string) => (await db.select().from(clients).where(eq(clients.id, id)))[0],
    byKeyHash: async (hash: string) => (await db.select().from(clients).where(eq(clients.keyHash, hash)))[0],
    byOAuthName: async (name: string) => (await db.select().from(clients).where(eq(clients.oauthName, name)))[0],
    activeKeys: () =>
      db
        .select()
        .from(clients)
        .where(and(eq(clients.kind, 'key'), isNull(clients.revokedAt))),
    upstreamsOf,
    pinsOf,
    packsOf,
    idsOfPack,
    globalPins: () => pinsOf(GLOBAL_PINS),
    setGlobalPins: (toolNames: string[]) => setPins(GLOBAL_PINS, toolNames),
    create: async (draft: ClientDraft) => {
      const id = `cl_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      await db.insert(clients).values({
        id,
        name: draft.name,
        kind: draft.kind,
        keyHash: draft.keyHash ?? null,
        oauthName: draft.oauthName ?? null,
        scope: draft.scope,
        allUpstreams: draft.upstreams === 'all',
        ownPins: Boolean(draft.pins),
        macTools: draft.macTools ?? false,
        resultCap: draft.resultCap ?? DEFAULT_RESULT_CAP,
        packId: draft.packId ?? draft.packIds?.[0] ?? null,
        expiresAt: draft.expiresAt ?? null,
        createdAt: new Date().toISOString(),
      })
      await setUpstreams(id, draft.upstreams)
      await setPacks(id, draft.packIds ?? (draft.packId ? [draft.packId] : []))
      if (draft.pins) await setPins(id, draft.pins)
      return id
    },
    update: async (id: string, change: ClientChange) => {
      const set = {
        ...(change.name === undefined ? {} : { name: change.name }),
        ...(change.scope === undefined ? {} : { scope: change.scope }),
        ...(change.macTools === undefined ? {} : { macTools: change.macTools }),
        ...(change.resultCap === undefined ? {} : { resultCap: change.resultCap }),
        ...(change.upstreams === undefined ? {} : { allUpstreams: change.upstreams === 'all' }),
        ...(change.pins === undefined ? {} : { ownPins: change.pins !== null }),
      }
      if (Object.keys(set).length) await db.update(clients).set(set).where(eq(clients.id, id))
      if (change.upstreams !== undefined) await setUpstreams(id, change.upstreams)
      if (change.pins !== undefined) await setPins(id, change.pins ?? [])
    },
    /** Which packs a key opens and which is its default (one of them). */
    setPacks: async (id: string, packIds: string[], defaultId: string) => {
      await setPacks(id, packIds)
      await db.update(clients).set({ packId: defaultId }).where(eq(clients.id, id))
    },
    /** Live keys that open a pack. */
    ofPack: async (packId: string) => {
      const ids = await idsOfPack(packId)
      return ids.length
        ? db
            .select()
            .from(clients)
            .where(and(inArray(clients.id, ids), isNull(clients.revokedAt)))
        : []
    },
    /** Drops every allowlist row and pin of a removed upstream, so a later one under the same id starts clean. */
    forgetUpstream: async (upstreamId: string) => {
      await db.delete(clientUpstreams).where(eq(clientUpstreams.upstreamId, upstreamId))
      await db.delete(pins).where(like(pins.toolName, `${upstreamId}.%`))
    },
    revoke: (id: string) => db.update(clients).set({ revokedAt: new Date().toISOString() }).where(eq(clients.id, id)),
  }
}

export type ClientsRepo = ReturnType<typeof clientsRepo>
