/** Clients, their allowlists and pins: the only queries on these tables. */
import { randomUUID } from 'node:crypto'
import { and, asc, eq, getTableColumns, gt, inArray, isNotNull, isNull, like } from 'drizzle-orm'
import { type Db, oauthKeys } from '../../kit/index.js'
import {
  type ClientPackRow,
  type ClientRow,
  clientGrants,
  clientLegacyMapping,
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
  /** The app's OAuth client id, shown to the owner. */
  oauthClientId?: string
  /** The sign-in it is made for: an OAuth client row is made with its first grant, or not at all. */
  grant?: string
  scope: 'read' | 'write'
  upstreams: 'all' | string[]
  pins?: string[] | null
  macTools?: boolean
  resultCap?: number
  /** The packs it opens, the first being its default unless `packId` says otherwise. */
  packIds?: string[]
  packId?: string | null
  expiresAt?: string | null
  app?: ClientRow['app']
}

export type ClientChange = Partial<
  Pick<ClientDraft, 'name' | 'scope' | 'upstreams' | 'pins' | 'macTools' | 'resultCap' | 'expiresAt'>
>

const HOUR_MS = 3_600_000
const nowSeconds = () => Math.floor(Date.now() / 1000)

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
  /** A client's links to the packs it opens, in order. */
  const linksOf = (clientId: string) =>
    db.select().from(clientPacks).where(eq(clientPacks.clientId, clientId)).orderBy(asc(clientPacks.position))
  const linkOf = (clientId: string, packId: string) =>
    and(eq(clientPacks.clientId, clientId), eq(clientPacks.packId, packId))
  /** A pack it keeps opening keeps its row, and with it what was noted there. */
  const setPacks = async (clientId: string, packIds: string[]) => {
    const had = new Set((await linksOf(clientId)).map((link) => link.packId))
    const dropped = [...had].filter((packId) => !packIds.includes(packId))
    if (dropped.length)
      await db.delete(clientPacks).where(and(eq(clientPacks.clientId, clientId), inArray(clientPacks.packId, dropped)))
    for (const [position, packId] of packIds.entries())
      if (had.has(packId)) await db.update(clientPacks).set({ position }).where(linkOf(clientId, packId))
      else await db.insert(clientPacks).values({ clientId, packId, position })
  }
  /** The packs a key opens, in order; a key from before lists stays on its one pack. */
  const packsOf = async (row: Pick<ClientRow, 'id' | 'packId'>) => {
    const ids = (await linksOf(row.id)).map((link) => link.packId)
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
    linksOf,
    packsOf,
    idsOfPack,
    /**
     * Notes the former name a client came to a pack by (`cameBy`), or that it came by the name now (null). Written
     * only when that changes, or to refresh a note over an hour old.
     */
    noteAddress: async (link: ClientPackRow, cameBy: string | null, now = new Date()) => {
      const fresh = link.cameByAt !== null && now.getTime() - Date.parse(link.cameByAt) < HOUR_MS
      if (cameBy ? link.cameBy === cameBy && fresh : !link.cameBy) return
      await db
        .update(clientPacks)
        .set({ cameBy, cameByAt: cameBy ? now.toISOString() : null })
        .where(linkOf(link.clientId, link.packId))
    },
    /** Who last came to a pack by a former name, which one and when. */
    cameBy: (packId: string) =>
      db
        .select({ clientId: clientPacks.clientId, cameBy: clientPacks.cameBy, cameByAt: clientPacks.cameByAt })
        .from(clientPacks)
        .where(and(eq(clientPacks.packId, packId), isNotNull(clientPacks.cameBy))),
    /** Drops the notes of a name that no longer leads to the pack. */
    forgetAddress: (packId: string, name: string) =>
      db
        .update(clientPacks)
        .set({ cameBy: null, cameByAt: null })
        .where(and(eq(clientPacks.packId, packId), eq(clientPacks.cameBy, name))),
    /** The client row a sign-in (the kit's grant) stands for. */
    byGrant: async (grant: string): Promise<ClientRow | undefined> =>
      (
        await db
          .select(getTableColumns(clients))
          .from(clientGrants)
          .innerJoin(clients, eq(clients.id, clientGrants.clientId))
          .where(eq(clientGrants.grant, grant))
      )[0],
    /** Maps a sign-in to a row; a grant mapped already keeps the row it has. */
    mapGrant: (grant: string, clientId: string, legacy = false) =>
      db.insert(clientGrants).values({ grant, clientId, legacy }).onConflictDoNothing(),
    /** Every sign-in a row stands for. */
    grantsOf: async (clientId: string) =>
      (await db.select().from(clientGrants).where(eq(clientGrants.clientId, clientId))).map((row) => row.grant),
    /** Whether the sign-ins from before 0.6.4 are mapped. */
    legacyMapped: async () => (await db.select().from(clientLegacyMapping).limit(1)).length > 0,
    markLegacyMapped: (signIns: number) =>
      db.insert(clientLegacyMapping).values({ at: new Date().toISOString(), signIns }),
    /** Sign-ins the kit still takes: unused refresh tokens, claimed registrations holding a claim token, unrevoked. */
    kitSignIns: async () => {
      const rows = await db
        .select()
        .from(oauthKeys)
        .where(
          and(
            inArray(oauthKeys.kind, ['refresh', 'registration', 'claim-token', 'revoked-family', 'revoked-client']),
            gt(oauthKeys.expiresAt, nowSeconds()),
          ),
        )
      const revoked = new Set(
        rows.filter((row) => row.kind.startsWith('revoked-')).map((row) => `${row.kind}:${row.id}`),
      )
      const uncollected = new Set(
        rows
          .filter((row) => row.kind === 'claim-token')
          .map((row) => String((JSON.parse(row.value) as Record<string, unknown>).registration)),
      )
      return rows.flatMap((row) => {
        if (row.kind !== 'refresh' && row.kind !== 'registration') return []
        const value = JSON.parse(row.value) as Record<string, unknown>
        const live = row.kind === 'refresh' ? !value.used : value.claimed === true && uncollected.has(row.id)
        const client = row.kind === 'refresh' ? String(value.client) : row.id
        const grant = String(value.family ?? row.id)
        if (!live || revoked.has(`revoked-family:${grant}`) || revoked.has(`revoked-client:${client}`)) return []
        return [{ grant, client, name: String(value.name ?? client) }]
      })
    },
    globalPins: () => pinsOf(GLOBAL_PINS),
    setGlobalPins: (toolNames: string[]) => setPins(GLOBAL_PINS, toolNames),
    create: async (draft: ClientDraft) => {
      const id = `cl_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      // The grant first, so one mapped already refuses the row; freed again when the row can't be made
      const { grant } = draft
      if (grant) await db.insert(clientGrants).values({ grant, clientId: id, legacy: false })
      const freeGrant = async (error: unknown) => {
        if (grant) await db.delete(clientGrants).where(eq(clientGrants.grant, grant))
        throw error
      }
      await db
        .insert(clients)
        .values({
          id,
          name: draft.name,
          kind: draft.kind,
          keyHash: draft.keyHash ?? null,
          oauthName: draft.oauthName ?? null,
          oauthClientId: draft.oauthClientId ?? null,
          scope: draft.scope,
          allUpstreams: draft.upstreams === 'all',
          ownPins: Boolean(draft.pins),
          macTools: draft.macTools ?? false,
          resultCap: draft.resultCap ?? DEFAULT_RESULT_CAP,
          packId: draft.packId ?? draft.packIds?.[0] ?? null,
          expiresAt: draft.expiresAt ?? null,
          app: draft.app ?? null,
          createdAt: new Date().toISOString(),
        })
        .catch(freeGrant)
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
        ...(change.expiresAt === undefined ? {} : { expiresAt: change.expiresAt }),
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
    /** The clients that open a pack and are not revoked, oldest first. */
    ofPack: (packId: string): Promise<ClientRow[]> =>
      db
        .select(getTableColumns(clients))
        .from(clients)
        .innerJoin(clientPacks, eq(clientPacks.clientId, clients.id))
        .where(and(eq(clientPacks.packId, packId), isNull(clients.revokedAt)))
        .orderBy(asc(clients.createdAt), asc(clients.id)),
    /** Drops every allowlist row and pin of a removed upstream, so a later one under the same id starts clean. */
    forgetUpstream: async (upstreamId: string) => {
      await db.delete(clientUpstreams).where(eq(clientUpstreams.upstreamId, upstreamId))
      await db.delete(pins).where(like(pins.toolName, `${upstreamId}.%`))
    },
    revoke: (id: string) => db.update(clients).set({ revokedAt: new Date().toISOString() }).where(eq(clients.id, id)),
  }
}

export type ClientsRepo = ReturnType<typeof clientsRepo>
