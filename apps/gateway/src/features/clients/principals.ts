/**
 * Who is calling, as the gateway sees it. The kit authenticates (API keys, OAuth tokens, Cloudflare Access); this turns
 * its `Caller` into a principal with an allowlist and a scope. Owner keys come from `API_KEYS`; client keys live in the
 * database and join the kit's key map at boot and whenever one is made or revoked.
 *
 * A key locked to a pack reaches only the pack: its upstreams become the pack's, and `reaches` / `runsTool` / `holds`
 * keep tools, playbooks and manuals to what is in it. A pack names its tools its own way (`entryOf`, `shownAs`).
 * The owner asking for a pack (its address or the header) is answered as a write key of that pack would be.
 */
import type { Context } from 'hono'
import { type Caller, mintApiKey, ProblemError } from '../../kit/index.js'
import type { CatalogRepo } from '../catalog/repo.js'
import { fixedOf, type PackEntry, presented } from '../packs/entries.js'
import { noPack } from '../packs/names.js'
import type { PacksRepo } from '../packs/repo.js'
import { isOff, type LiveTool, needsWrite } from '../tools/repo.js'
import { dayOf } from './lifetimes.js'
import type { ClientDraft, ClientsRepo } from './repo.js'
import type { ClientPackRow, ClientRow } from './schema.js'

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
  /**
   * The client's own pins, or null. A pin names what the client calls: inside a pack, the pack's name for the tool.
   * Null means the global pins outside a pack and every tool of the pack inside one, where global pins never apply.
   */
  pins: string[] | null
  macTools: boolean
  resultCap: number
  /** The pack this request is locked to: the one its address names, else the key's default. */
  pack: PackScope | null
  /** Every pack the key opens (each at `/p/<name>/`), the default first. */
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

/**
 * The caller, with the pack its address or `x-gateway-pack` header asked for (see `packChoice`): by the name the
 * pack has now, with the former name that was asked as `cameBy` when it came by one.
 */
export const callerOf = (c: Context) =>
  c.get('caller' as never) as (Caller & { pack?: string; cameBy?: string }) | undefined

export const isOwner = (caller: Caller | undefined) =>
  caller?.kind === 'person' || (caller?.kind === 'key' && !caller.name.startsWith(CLIENT_KEY))

/** Throws 403 unless the caller is the owner (an owner key or a person through Access) asking outside a pack. */
export const requireOwner = (c: Context) => {
  const caller = callerOf(c)
  if (!isOwner(caller))
    throw new ProblemError('forbidden', { detail: 'Only the owner manages the gateway: use an owner key or /app.' })
  if (caller?.pack)
    throw new ProblemError('forbidden', {
      detail: `This request is for the pack ${caller.pack} only: manage the gateway at /api or in /app, without a pack.`,
    })
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

/** How and when a client's access ended, or null while it works. */
export const endingOf = (
  row: Pick<ClientRow, 'revokedAt' | 'expiresAt'>,
  now = new Date(),
): { how: 'revoked' | 'expired'; at: string } | null =>
  row.revokedAt
    ? { how: 'revoked', at: row.revokedAt }
    : row.expiresAt && row.expiresAt <= now.toISOString()
      ? { how: 'expired', at: row.expiresAt }
      : null

/**
 * Why a key no longer works, said where the caller sees it: in `pack`, the pack it asked for or its default. Only an
 * OAuth client hears the revoked sentence: a revoked key is no longer known and gets the kit's 401.
 */
export const refusalOf = (
  row: Pick<ClientRow, 'revokedAt' | 'expiresAt'>,
  pack: { title: string } | null = null,
  now = new Date(),
) => {
  const ending = endingOf(row, now)
  if (!ending) return null
  if (ending.how === 'revoked') return 'This key was revoked: the owner can issue a new one in /app.'
  return pack
    ? `Your access to ${pack.title} ended on ${dayOf(ending.at)}. Ask the owner for a new invite.`
    : `This key expired on ${dayOf(ending.at)}: the owner can issue a new one in /app.`
}

/** The same ending, said to the owner looking as that client. */
export const endedNote = (
  row: Pick<ClientRow, 'id' | 'name' | 'revokedAt' | 'expiresAt'>,
  pack: { title: string } | null = null,
  now = new Date(),
) => {
  const ending = endingOf(row, now)
  if (!ending) return null
  const nothing = `so there is nothing to see as ${row.name}`
  if (ending.how === 'revoked')
    return `${row.name}'s key was revoked on ${dayOf(ending.at)}, ${nothing}: make a new key.`
  const what = pack ? `access to ${pack.title} ended` : 'key expired'
  return `${row.name}'s ${what} on ${dayOf(ending.at)}, ${nothing}: extend it with PATCH /api/clients/${row.id} {"expiresIn":"30d"}.`
}

const upstreamOfTool = (name: string) => name.slice(0, name.indexOf('.'))

/** A pack a key opens, as the lock and the refusals name it. */
type Opened = { id: string; name: string; title: string }

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
  /**
   * The pack a request is locked to: the one asked for when the key opens it (with the key's `link` to it), else the
   * key's default. Asked for a pack the key doesn't open, it is the default with a `refusal`, so an ended key is
   * still told a pack of its own. The refusal names the pack as it was `asked` for, never as `choice`, the name it
   * has now: a key that does not open a pack never learns what it is called today.
   */
  const packFor = async (
    row: ClientRow,
    choice: string | undefined,
    asked = choice,
  ): Promise<{ id: string | null; opened: Opened[]; link?: ClientPackRow; refusal?: string }> => {
    const links = await clients.linksOf(row.id)
    // A key from before lists stays on its one pack
    const ids = links.length ? links.map((link) => link.packId) : row.packId ? [row.packId] : []
    const opened = (await Promise.all(ids.map((id) => packs.byId(id)))).filter((pack) => pack !== undefined)
    const byDefault = { id: row.packId ?? ids[0] ?? null, opened }
    if (!choice) return byDefault
    const chosen = opened.find((pack) => pack.name === choice)
    const link = links.find((held) => held.packId === chosen?.id)
    if (chosen) return { id: chosen.id, opened, ...(link ? { link } : {}) }
    return {
      ...byDefault,
      refusal: ids.length
        ? `This key doesn't open the pack ${asked}. It opens ${opened.map((pack) => `${pack.name} (/p/${pack.name}/mcp)`).join(', ')}.`
        : `This key isn't locked to packs: connect to /mcp, which serves everything it may reach.`,
    }
  }
  /** The pack a request is locked to, for the sentence that names it; null outside packs and for a removed pack. */
  const titled = (chosen: { id: string | null; opened: Opened[] }) =>
    chosen.opened.find((opened) => opened.id === chosen.id) ?? null
  const fromRow = async (
    row: ClientRow,
    scopeCap: 'read' | 'write' | undefined,
    chosen: { id: string | null; opened: Opened[] },
  ): Promise<Principal> => {
    const pack = chosen.id ? await packScopeOf(chosen.id) : null
    const byDefault = [...chosen.opened].sort((a, b) => Number(b.id === row.packId) - Number(a.id === row.packId))
    return {
      id: row.id,
      name: row.name,
      owner: false,
      scope: scopeCap === 'read' ? 'read' : row.scope,
      // A key whose pack was removed reaches nothing rather than everything: never its own allowlist
      upstreams: chosen.id ? (pack ? await upstreamsOfPack(pack) : []) : await clients.upstreamsOf(row),
      pins: row.ownPins ? await clients.pinsOf(row.id) : null,
      macTools: pack ? false : row.macTools,
      resultCap: row.resultCap,
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
  /** The owner inside a pack: what a write key of that pack would see and run; why not when there is no such pack. */
  const inPack = async (name: string): Promise<Principal | string> => {
    const row = await packs.get(name)
    const scope = row && (await packScopeOf(row.id))
    if (!scope) return noPack(packs, name)
    return {
      ...OWNER,
      owner: false,
      upstreams: await upstreamsOfPack(scope),
      macTools: false,
      pack: scope,
      packs: [{ name: scope.name, title: scope.title }],
    }
  }
  /** The principal behind a request, or why it has none (revoked, expired, unknown, a pack it doesn't open). */
  const resolve = async (caller: ReturnType<typeof callerOf>): Promise<Principal | string> => {
    if (!caller) return 'No credentials: send an API key as a bearer token.'
    if (isOwner(caller)) return caller.pack ? inPack(caller.pack) : OWNER
    const { row, scopeCap } = await rowOf(caller)
    if (!row) return 'This key is not known to the gateway.'
    const chosen = await packFor(row, caller.pack, caller.cameBy ?? caller.pack)
    const refusal = refusalOf(row, titled(chosen)) ?? chosen.refusal
    if (refusal) return refusal
    // Which address it is set up with: the pack's old one, or (clearing the note) the one it has now
    if (chosen.link) await clients.noteAddress(chosen.link, caller.cameBy ?? null)
    return fromRow(row, scopeCap, chosen)
  }

  return {
    loadKeys: async () => {
      for (const row of await clients.activeKeys()) if (row.keyHash) keys.set(row.keyHash, `${CLIENT_KEY}${row.id}`)
    },
    /** Makes a key client and lets it in at once. The key is returned this once; only its hash is kept. */
    issue: async (draft: Omit<ClientDraft, 'kind' | 'keyHash'>): Promise<{ id: string; key: string }> => {
      const { key, hash } = mintApiKey('gw')
      const id = await clients.create({ ...draft, kind: 'key', keyHash: hash })
      keys.set(hash, `${CLIENT_KEY}${id}`)
      return { id, key }
    },
    dropKey: (hash: string | null) => hash && keys.delete(hash),
    /** The principal behind a request, or null when it has none (revoked or expired client). */
    of: async (caller: ReturnType<typeof callerOf>): Promise<Principal | null> => {
      const found = await resolve(caller)
      return typeof found === 'string' ? null : found
    },
    inPack,
    /**
     * A client as the gateway sees it, for the owner's preview (in `pack`, one of its packs, else its default); why
     * not when it can no longer call or doesn't open that pack.
     */
    ofClient: async (id: string, pack?: string): Promise<Principal | string> => {
      const row = await clients.get(id)
      if (!row) return `No client ${id}. GET /api/clients lists them.`
      const chosen = await packFor(row, pack)
      return endedNote(row, titled(chosen)) ?? chosen.refusal ?? fromRow(row, undefined, chosen)
    },
    /** Why this caller's access has ended, or null: the one refusal the MCP door lets in, to be said in words. */
    ended: async (caller: ReturnType<typeof callerOf>): Promise<string | null> => {
      if (!caller || isOwner(caller)) return null
      const { row } = await rowOf(caller)
      return row && endingOf(row) ? refusalOf(row, titled(await packFor(row, caller.pack))) : null
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

/** The names listed directly in this principal's MCP tool list, before what is live, off or beyond its scope is cut. */
export const pinnedBy = (principal: Principal, globalPins: string[]) =>
  principal.pack
    ? (principal.pins?.filter((name) => reaches(principal, name)) ?? [...principal.pack.tools.keys()])
    : (principal.pins ?? globalPins)

/**
 * Is this tool listed for this caller, within an upstream it reaches? Off tools only for the owner, tools that change
 * things only for a write key, and for a pack key only the pack's.
 */
export const seenBy = (principal: Principal) => (tool: Pick<LiveTool, 'name' | 'access' | 'annotations'>) =>
  runsTool(principal, tool.name) &&
  (principal.owner || !isOff(tool)) &&
  (principal.scope === 'write' || !needsWrite(tool))
