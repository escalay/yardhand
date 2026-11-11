/** The gateway's services, wired once: repos, the vault, adapters, sync and the call pipeline. Features get these. */

import { join } from 'node:path'
import { authHeaders, type Credential, createAdapters } from './adapters/index.js'
import { type Env as AiEnv, type AiJob, type AiSettings, resolveGrouping, resolveSearch } from './features/ai/config.js'
import { createHanded } from './features/calls/handed.js'
import { createPipeline } from './features/calls/pipeline.js'
import { createReads } from './features/calls/reads.js'
import { callsRepo } from './features/calls/repo.js'
import { createTraceSender, traceContext } from './features/calls/traces.js'
import { catalogRepo } from './features/catalog/repo.js'
import { createPrincipals } from './features/clients/principals.js'
import { clientsRepo } from './features/clients/repo.js'
import { callbackPath, vaultOAuthProvider } from './features/connections/provider.js'
import { createEvents } from './features/events/bus.js'
import { createGrouping } from './features/groups/grouping.js'
import { packsRepo } from './features/packs/repo.js'
import { searchesRepo } from './features/searches/repo.js'
import type { Telemetry } from './features/telemetry/index.js'
import { contextOf, type MeaningSearch, openRouterMeaning } from './features/tools/meaning.js'
import { toolsRepo } from './features/tools/repo.js'
import { upstreamsRepo } from './features/upstreams/repo.js'
import { secretIdOf, type UpstreamRow } from './features/upstreams/schema.js'
import { createSync, endpointOf } from './features/upstreams/sync.js'
import { createWatcher } from './features/upstreams/watch.js'
import { parseMasterKey } from './features/vault/crypto.js'
import { vaultRepo } from './features/vault/repo.js'
import type { JobRun, Jobs } from './jobs.js'
import type { Db } from './kit/index.js'
import { VERSION } from './version.js'

export type Env = {
  API_KEYS?: string
  OAUTH_SIGNING_KEY?: string
  ACCESS_TEAM?: string
  ACCESS_AUD?: string
  PUBLIC_HOST?: string
  GATEWAY_MASTER_KEY?: string
  OPENROUTER_API_KEY?: string
  STATE_DIR?: string
  GATEWAY_LANGFUSE_URL?: string
  GATEWAY_LANGFUSE_PUBLIC_KEY?: string
  GATEWAY_LANGFUSE_SECRET_KEY?: string
  DISCORD_WEBHOOK_URL?: string
  /** The commit the image was built from, for Settings. */
  GATEWAY_BUILD?: string
  /** A Composio CLI user key: personal Composio upstreams read Composio's tool list with it. */
  COMPOSIO_API_KEY?: string
  /** Smart grouping's starting values; Settings › AI wins over them (features/ai/config.ts). */
  GATEWAY_AI_GROUPING_PROVIDER?: string
  GATEWAY_AI_GROUPING_BASE_URL?: string
  GATEWAY_AI_GROUPING_KEY?: string
  GATEWAY_AI_GROUPING_WRITER_MODEL?: string
  GATEWAY_AI_GROUPING_DECIDER_MODEL?: string
  GATEWAY_AI_GROUPING_DECIDER_PROTOCOL?: string
  /** Usage telemetry (features/telemetry): `off`, the collector's address, and the shared off switch. */
  GATEWAY_TELEMETRY?: string
  GATEWAY_TELEMETRY_URL?: string
  DO_NOT_TRACK?: string
  /** How it was installed, set by the template that started it. */
  GATEWAY_INSTALL?: string
  /** The built browser app (`apps/web/dist`); without one the gateway serves the API alone. */
  WEB_DIR?: string
}

/**
 * Where the owner and agents reach the gateway, from `PUBLIC_HOST`: a bare name is served over HTTPS
 * (`gateway.example.test`); with a scheme it is taken as written, for a plain-HTTP address on a LAN or a port
 * (`http://nas.local:8080`). Unset, the dev address.
 */
export const publicOriginOf = (host: string | undefined) =>
  !host ? 'http://localhost:4400' : /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `https://${host}`

export const createServices = async ({
  db,
  env,
  keys,
  meaning: given,
}: {
  db: Db
  env: Env
  keys: Map<string, string>
  /** Search by meaning; tests pass a fake one. Without it and without a key, search is by keywords only. */
  meaning?: MeaningSearch
}) => {
  const masterKey = parseMasterKey(env.GATEWAY_MASTER_KEY)
  const vault = vaultRepo(db, masterKey)
  const clients = clientsRepo(db)
  const upstreams = upstreamsRepo(db)
  const tools = toolsRepo(db)
  const catalog = catalogRepo(db)
  const searches = searchesRepo(db)
  const log = callsRepo(db, masterKey)
  // Langfuse gets every call's metadata when the gateway has its own Langfuse keys; never arguments or results
  const traces =
    env.GATEWAY_LANGFUSE_PUBLIC_KEY && env.GATEWAY_LANGFUSE_SECRET_KEY
      ? createTraceSender({
          baseUrl: env.GATEWAY_LANGFUSE_URL ?? 'https://cloud.langfuse.com',
          publicKey: env.GATEWAY_LANGFUSE_PUBLIC_KEY,
          secretKey: env.GATEWAY_LANGFUSE_SECRET_KEY,
        })
      : null
  const events = createEvents()
  /** The last run of each scheduled job, for Settings. */
  const jobRuns = new Map<string, JobRun>()
  /** The scheduler, once the server starts it (tests and the demo run without one). */
  const jobs: { current: Jobs | null } = { current: null }
  /** Usage telemetry, once the server starts it. */
  const telemetry: { current: Telemetry | null } = { current: null }
  /** Ends the process so its supervisor starts it again, where the server runs under one. */
  const restart: { current: (() => void) | null } = { current: null }
  const calls: typeof log = {
    ...log,
    record: async (row) => {
      const parent = traceContext.getStore() ?? null
      const id = await log.record({ ...row, traceId: parent?.traceId ?? null })
      events.emit({
        type: 'call',
        data: {
          id,
          client: row.clientName,
          clientId: row.clientId,
          tool: row.tool,
          kind: row.kind ?? 'tool',
          upstream: row.upstreamId,
          via: row.via,
          status: row.status,
          durationMs: row.durationMs,
          createdAt: new Date().toISOString(),
        },
      })
      traces?.send({
        callId: id,
        client: row.clientName,
        tool: row.tool,
        upstream: row.upstreamId,
        via: row.via,
        status: row.status,
        durationMs: row.durationMs,
        resultBytes: row.resultBytes,
        at: new Date().toISOString(),
        parent,
      })
      return id
    },
  }
  /** Where this gateway is reached; OAuth upstreams send the owner back here. */
  const publicOrigin = publicOriginOf(env.PUBLIC_HOST)
  const oauthProviderFor = (upstreamId: string, onRedirect?: (url: URL) => void) =>
    vaultOAuthProvider({ vault, upstreamId, redirectUrl: `${publicOrigin}${callbackPath}`, onRedirect })
  const adapters = createAdapters(
    { name: 'yardhand', version: VERSION },
    (upstreamId) => oauthProviderFor(upstreamId),
    { composioCatalogKey: env.COMPOSIO_API_KEY },
  )
  const credentialOf = (id: string) => vault.get<Credential>(secretIdOf(id))
  const packs = packsRepo(db)
  const handed = createHanded({ calls, catalog })
  const principals = createPrincipals({ clients, packs, catalog, keys })
  await principals.loadKeys()
  /** The AI jobs' settings: Settings (sealed in the vault) over .env over defaults. */
  const ai = {
    saved: (job: AiJob) => vault.get<AiSettings>(`ai:${job}`),
    search: async () => resolveSearch(await vault.get<AiSettings>('ai:search'), env as AiEnv),
    grouping: async () => resolveGrouping(await vault.get<AiSettings>('ai:grouping'), env as AiEnv),
  }
  /** Search by meaning with the key the search job has now; rebuilt when it changes in Settings. */
  const meaningWith = (apiKey: string) =>
    openRouterMeaning({
      apiKey,
      file: join(env.STATE_DIR ?? '.state', 'vectors', 'tools.jsonl'),
      tools,
      contexts: async () => new Map((await upstreams.list()).map((row) => [row.id, contextOf(row)])),
    })
  let searchKey = (await ai.search()).key.value
  let current: MeaningSearch | null = searchKey ? meaningWith(searchKey) : null
  const meaning: MeaningSearch | null =
    given ??
    ({
      refresh: () => current?.refresh() ?? Promise.resolve(),
      names: (q, limit) => current?.names(q, limit) ?? Promise.resolve([]),
      ready: () => Boolean(current),
    } satisfies MeaningSearch)
  /** Picks up a new search key: a fresh meaning index, filled in the background. */
  const searchKeyChanged = async () => {
    if (given) return
    const key = (await ai.search()).key.value
    if (key === searchKey) return
    searchKey = key
    current = key ? meaningWith(key) : null
    void current?.refresh()
  }
  /** The headers that reach an upstream directly (link proxy, passthrough): its key, or its OAuth access token. */
  const upstreamHeaders = async (row: UpstreamRow) => {
    if (row.auth !== 'oauth') return authHeaders(endpointOf(row), await credentialOf(row.id))
    const token = (await oauthProviderFor(row.id).tokens())?.access_token
    return token ? { authorization: `Bearer ${token}` } : {}
  }
  const syncOnly = createSync({ upstreams, tools, catalog, adapters, credentialOf })
  const grouping = createGrouping({ tools, upstreams, adapters, credentialOf, smart: () => ai.grouping() })
  /** One sync of an upstream at a time: the hourly job, a live notice and the owner can all ask at once. */
  const syncing = new Map<string, Promise<unknown>>()
  const sync = (id: string) => {
    const turn = (syncing.get(id) ?? Promise.resolve()).catch(() => null).then(() => syncOnce(id))
    syncing.set(id, turn)
    return turn
  }
  /** A sync, then a meaning refresh in the background when the live tools changed. */
  const syncOnce = async (id: string) => {
    const before = (await upstreams.get(id))?.status
    const announce = async () => {
      const row = await upstreams.get(id)
      if (row && row.status !== before)
        events.emit({ type: 'upstream', data: { upstream: id, status: row.status, lastError: row.lastError } })
    }
    const summary = await syncOnly(id).catch(async (error: unknown) => {
      await announce()
      throw error
    })
    await announce()
    // New tools go into groups before anyone lists them; a failure here never fails the sync
    await grouping.file(id).catch(() => null)
    events.emit({
      type: 'sync',
      data: {
        upstream: id,
        added: summary.added,
        changed: summary.changed,
        pending: summary.pending,
        removed: summary.removed,
        catalog: summary.catalog,
      },
    })
    if (meaning && (summary.added.length || summary.changed.length || summary.restored.length)) void meaning.refresh()
    const toolsMoved = Boolean(
      summary.added.length + summary.changed.length + summary.removed.length + summary.restored.length,
    )
    const catalogMoved = Boolean(
      summary.catalog.added.length + summary.catalog.changed.length + summary.catalog.removed.length,
    )
    if (toolsMoved || catalogMoved)
      events.emit({ type: 'lists', data: { tools: toolsMoved, prompts: catalogMoved, resources: catalogMoved } })
    return summary
  }
  if (meaning) void meaning.refresh()
  // Connections from before groups get theirs; later syncs file new tools as they come
  void (async () => {
    for (const row of await upstreams.list()) await grouping.file(row.id).catch(() => null)
  })()
  const watcher = createWatcher({ upstreams, adapters, credentialOf, sync })
  /** Tells connected agents to list again after the owner changed what they see. */
  const listsChanged = (what: { tools?: boolean; prompts?: boolean; resources?: boolean } = {}) => {
    const all = !Object.keys(what).length
    events.emit({
      type: 'lists',
      data: {
        tools: all || Boolean(what.tools),
        prompts: all || Boolean(what.prompts),
        resources: all || Boolean(what.resources),
      },
    })
  }
  return {
    db,
    env,
    /** Langfuse, when the gateway has its keys. */
    traces,
    startedAt: new Date().toISOString(),
    jobRuns,
    jobs,
    telemetry,
    restart,
    vault,
    clients,
    upstreams,
    tools,
    catalog,
    searches,
    calls,
    events,
    adapters,
    oauthProviderFor,
    publicOrigin,
    principals,
    packs,
    credentialOf,
    upstreamHeaders,
    meaning,
    ai: { ...ai, searchKeyChanged },
    sync,
    grouping,
    watcher,
    listsChanged,
    handed,
    pipeline: createPipeline({ tools, upstreams, adapters, calls, credentialOf, key: masterKey, handed }),
    reads: createReads({ catalog, tools, upstreams, adapters, calls, credentialOf, handed }),
  }
}

export type Services = Awaited<ReturnType<typeof createServices>>
