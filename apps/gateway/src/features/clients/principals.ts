/**
 * Who is calling, as the gateway sees it. The kit authenticates (API keys, OAuth tokens, Cloudflare Access); this turns
 * its `Caller` into a principal with an allowlist and a scope. Owner keys come from `API_KEYS`; client keys live in the
 * database and join the kit's key map at boot and whenever one is made or revoked.
 *
 * A key locked to a pack reaches only the pack: its upstreams become the pack's, and `reaches` / `runsTool` / `holds`
 * keep tools, playbooks and manuals to what is in it. A pack names its tools its own way (`entryOf`, `shownAs`).
 */
import type { Context } from 'hono'
import { type Caller, ProblemError } from '../../kit/index.js'
import type { CatalogRepo } from '../catalog/repo.js'
import { fixedOf, type PackEntry, presented } from '../packs/entries.js'
import type { PacksRepo } from '../packs/repo.js'
import { isOff, type LiveTool, needsWrite } from '../tools/repo.js'
import type { ClientsRepo } from './repo.js'
import type { ClientRow } from './schema.js'

/** The pack a key is locked to, as the lock needs it. */
export type PackScope = {
  id: string
  name: string
  title: string
  description: string
  /** The names its keys call, in order, each with the tool behind it, the pack's wording and what it fixes. */
  tools: Map<string, PackEntry>
  playbooks: Set<string>
  manuals: Set<string>
}

export type Principal = {
  id: string
  name: string
  owner: boolean
  scope: 'read' | 'write'
  upstreams: 'all' | string[]
  /** The client's own pins, or null to use the global default. */
  pins: string[] | null
  macTools: boolean
  resultCap: number
  /** The pack this request is locked to: the one its address names, else the key's default. */
  pack: PackScope | null
  /** Every pack the key opens (each at `/mcp/p/<name>`), the default first. */
  packs: { name: string; title: string }[]
}

const CLIENT_KEY = 'client:'

export const OWNER: Principal = {
  id: 'owner',
  name: 'owner',
  owner: true,
  scope: 'write',
  upstreams: 'all',
  pins: null,
  macTools: true,
  resultCap: 25_000,
  pack: null,
  packs: [],
}

/** The caller, with the pack its address or `x-gateway-pack` header asked for (see `packChoice`). */
export const callerOf = (c: Context) => c.get('caller' as never) as (Caller & { pack?: string }) | undefined

export const isOwner = (caller: Caller | undefined) =>
  caller?.kind === 'person' || (caller?.kind === 'key' && !caller.name.startsWith(CLIENT_KEY))

/** Throws 403 unless the caller is the owner (an owner key or a person through Access). */
export const requireOwner = (c: Context) => {
  if (!isOwner(callerOf(c)))
    throw new ProblemError('forbidden', { detail: 'Only the owner manages the gateway: use an owner key or /app.' })
}

export const allows = (principal: Principal, upstreamId: string) =>
  principal.upstreams === 'all' || principal.upstreams.includes(upstreamId)

/** May this principal use this name? Outside a pack, its allowlist decides; inside one, only the pack's names. */
export const reaches = (principal: Principal, name: string) => !principal.pack || principal.pack.tools.has(name)

/** Does its pack run this tool (`<upstream>.<tool>`) under any name? Always true outside a pack. */
export const runsTool = (principal: Principal, toolName: string) =>
  !principal.pack || [...principal.pack.tools.values()].some((entry) => entry.tool === toolName)

/** The tool behind a name this principal calls, with the inputs its pack fills; null when its pack has no such name. */
export const entryOf = (
  principal: Principal,
  name: string,
): { tool: string; fixed: Record<string, unknown> } | null => {
  if (!principal.pack) return { tool: name, fixed: {} }
  const entry = principal.pack.tools.get(name)
  return entry ? { tool: entry.tool, fixed: entry.fixed } : null
}

/** May it read this playbook or manual? A pack holds its own; without one, its allowlist decides. */
export const holds = (principal: Principal, item: { kind: string; name: string }) =>
  !principal.pack ||
  (item.kind === 'playbook'
    ? principal.pack.playbooks.has(item.name)
    : item.kind === 'manual'
      ? principal.pack.manuals.has(item.name)
      : true)

/**
 * The tool as this principal reads it: as itself outside a pack; inside one, once per name the pack runs it under,
 * each with that name, the pack's wording and the schema without what it fixes (in pack order).
 */
export const shownAs = <T extends { name: string; description: string; inputSchema: Record<string, unknown> }>(
  principal: Principal,
  tool: T,
): T[] =>
  principal.pack
    ? [...principal.pack.tools]
        .filter(([, entry]) => entry.tool === tool.name)
        .map(([name, entry]) => presented(tool, name, entry))
    : [tool]

/** The tool under one name this principal calls (its pack's alias, or the tool's own name). */
export const describe = <T extends { name: string; description: string; inputSchema: Record<string, unknown> }>(
  principal: Principal,
  tool: T,
  name = tool.name,
): T => {
  const entry = principal.pack?.tools.get(name)
  return entry ? presented(tool, name, entry) : tool
}

/** Why a key no longer works, said where the caller sees it. */
export const refusalOf = (row: Pick<ClientRow, 'revokedAt' | 'expiresAt'>, now = new Date()) =>
  row.revokedAt
    ? 'This key was revoked: the owner can issue a new one in /app.'
    : row.expiresAt && row.expiresAt <= now.toISOString()
      ? `This key expired at ${row.expiresAt}: the owner can issue a new one in /app.`
      : null

const upstreamOfTool = (name: string) => name.slice(0, name.indexOf('.'))

export const createPrincipals = ({
  clients,
  packs,
  catalog,
  keys,
}: {
  clients: ClientsRepo
  packs: PacksRepo
  catalog: CatalogRepo
  keys: Map<string, string>
}) => {
  const packScopeOf = async (packId: string): Promise<PackScope | null> => {
    const pack = await packs.byId(packId)
    if (!pack) return null
    const contents = await packs.contentsOf(pack)
    return {
      id: pack.id,
      name: pack.name,
      title: pack.title,
      description: pack.description,
      tools: new Map(
        contents.tools.map((row) => [row.name, { tool: row.toolName, wording: row.description, fixed: fixedOf(row) }]),
      ),
      playbooks: new Set(contents.playbooks),
      manuals: new Set(contents.manuals),
    }
  }
  /** A pack's upstreams: those of its tools, playbooks and manuals. */
  const upstreamsOfPack = async (scope: PackScope) => {
    const items = await catalog.liveNames([...scope.playbooks, ...scope.manuals])
    return [
      ...new Set([
        ...[...scope.tools.values()].map((entry) => upstreamOfTool(entry.tool)),
        ...items.map((item) => item.upstreamId),
      ]),
    ].sort()
  }
  /** The pack a request is locked to: the one asked for when the key opens it, else the key's default. */
  const packFor = async (row: ClientRow, choice: string | undefined) => {
    const ids = await clients.packsOf(row)
    const opened = (await Promise.all(ids.map((id) => packs.byId(id)))).filter((pack) => pack !== undefined)
    if (!choice) return { id: row.packId ?? ids[0] ?? null, opened }
    const chosen = opened.find((pack) => pack.name === choice)
    if (chosen) return { id: chosen.id, opened }
    return {
      refusal: ids.length
        ? `This key doesn't open the pack ${choice}. It opens ${opened.map((pack) => `${pack.name} (/mcp/p/${pack.name})`).join(', ')}.`
        : `This key isn't locked to packs: connect to /mcp, which serves everything it may reach.`,
    }
  }
  const fromRow = async (
    row: ClientRow,
    scopeCap: 'read' | 'write' | undefined,
    chosen: { id: string | null; opened: { id: string; name: string; title: string }[] },
  ): Promise<Principal> => {
    const pack = chosen.id ? await packScopeOf(chosen.id) : null
    const byDefault = [...chosen.opened].sort((a, b) => Number(b.id === row.packId) - Number(a.id === row.packId))
    return {
      id: row.id,
      name: row.name,
      owner: false,
      scope: scopeCap === 'read' ? 'read' : row.scope,
      upstreams: pack ? await upstreamsOfPack(pack) : await clients.upstreamsOf(row),
      pins: pack ? [...pack.tools.keys()] : row.ownPins ? await clients.pinsOf(row.id) : null,
      macTools: pack ? false : row.macTools,
      resultCap: row.resultCap,
      // A key whose pack was removed reaches nothing rather than everything
      pack: chosen.id
        ? (pack ?? {
            id: chosen.id,
            name: 'removed',
            title: 'a removed pack',
            description: '',
            tools: new Map(),
            playbooks: new Set(),
            manuals: new Set(),
          })
        : null,
      packs: byDefault.map((opened) => ({ name: opened.name, title: opened.title })),
    }
  }
  /** The client row behind a caller (OAuth clients appear on first use), with the token's scope cap. */
  const rowOf = async (caller: Caller): Promise<{ row: ClientRow | undefined; scopeCap?: 'read' | 'write' }> => {
    if (caller.kind === 'key') return { row: await clients.get(caller.name.slice(CLIENT_KEY.length)) }
    if (caller.kind !== 'agent') return { row: undefined }
    const scopeCap = caller.scopes.includes('write') ? 'write' : 'read'
    const known = await clients.byOAuthName(caller.name)
    if (known) return { row: known, scopeCap }
    // Two first requests at once: the second finds the row the first just made
    const id = await clients
      .create({ name: caller.name, kind: 'oauth', oauthName: caller.name, scope: 'write', upstreams: 'all' })
      .catch(() => null)
    return { row: id ? await clients.get(id) : await clients.byOAuthName(caller.name), scopeCap }
  }
  /** The principal behind a request, or why it has none (revoked, expired, unknown, a pack it doesn't open). */
  const resolve = async (caller: ReturnType<typeof callerOf>): Promise<Principal | string> => {
    if (!caller) return 'No credentials: send an API key as a bearer token.'
    if (isOwner(caller))
      return caller.pack
        ? 'Pack addresses are for pack keys: the owner sees every tool at /mcp, and a pack’s page in /app shows what its keys see.'
        : OWNER
    const { row, scopeCap } = await rowOf(caller)
    if (!row) return 'This key is not known to the gateway.'
    const refused = refusalOf(row)
    if (refused) return refused
    const chosen = await packFor(row, caller.pack)
    return 'refusal' in chosen ? (chosen.refusal ?? 'Not allowed.') : fromRow(row, scopeCap, chosen)
  }

  return {
    loadKeys: async () => {
      for (const row of await clients.activeKeys()) if (row.keyHash) keys.set(row.keyHash, `${CLIENT_KEY}${row.id}`)
    },
    addKey: (hash: string, clientId: string) => keys.set(hash, `${CLIENT_KEY}${clientId}`),
    dropKey: (hash: string | null) => hash && keys.delete(hash),
    /** The principal behind a request, or null when it has none (revoked or expired client). */
    of: async (caller: ReturnType<typeof callerOf>): Promise<Principal | null> => {
      const found = await resolve(caller)
      return typeof found === 'string' ? null : found
    },
    /** A client as the gateway sees it, for the owner's preview; why not when it can no longer call. */
    ofClient: async (id: string): Promise<Principal | string> => {
      const row = await clients.get(id)
      if (!row) return `No client ${id}. GET /api/clients lists them.`
      const chosen = await packFor(row, undefined)
      return (
        refusalOf(row) ?? ('refusal' in chosen ? (chosen.refusal ?? 'Not allowed.') : fromRow(row, undefined, chosen))
      )
    },
    /** The principal behind a request; a 403 saying why when it has none. */
    require: async (caller: ReturnType<typeof callerOf>): Promise<Principal> => {
      const found = await resolve(caller)
      if (typeof found === 'string') throw new ProblemError('forbidden', { detail: found })
      return found
    },
  }
}

export type Principals = ReturnType<typeof createPrincipals>

/**
 * Is this tool listed for this caller, within an upstream it reaches? Off tools only for the owner, tools that change
 * things only for a write key, and for a pack key only the pack's.
 */
export const seenBy = (principal: Principal) => (tool: Pick<LiveTool, 'name' | 'access' | 'annotations'>) =>
  runsTool(principal, tool.name) &&
  (principal.owner || !isOff(tool)) &&
  (principal.scope === 'write' || !needsWrite(tool))
