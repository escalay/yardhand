/**
 * Sync: reads an upstream's tools and reconciles them with the registry. New and changed tools from a `trusted`
 * upstream (and everything on the first sync) go live; from a `review` upstream they wait as `pending` while the old
 * version keeps serving. Tools the upstream no longer lists stop being served.
 */
import type { Adapters, Credential, Endpoint } from '../../adapters/index.js'
import { ProblemError } from '../../kit/index.js'
import type { CatalogRepo } from '../catalog/repo.js'
import { type CatalogSummary, reconcileCatalog } from '../catalog/sync.js'
import { hashDefinition, type ToolDefinition, type ToolsRepo } from '../tools/repo.js'
import type { UpstreamsRepo } from './repo.js'
import type { UpstreamRow } from './schema.js'

export type SyncSummary = {
  added: string[]
  changed: string[]
  pending: string[]
  removed: string[]
  restored: string[]
  /** Manuals, playbooks and links, by the names agents see. */
  catalog: CatalogSummary
}

/** `<upstream>.<tool>` using only the characters MCP allows in tool names. */
export const toolNameOf = (upstreamId: string, remoteName: string) =>
  `${upstreamId}.${remoteName.replace(/[^A-Za-z0-9_.-]/g, '_')}`.slice(0, 128)

export const endpointOf = (row: UpstreamRow): Endpoint => ({
  id: row.id,
  kind: row.kind,
  url: row.url,
  auth: row.auth,
  authHeader: row.authHeader,
  config: row.config ? (JSON.parse(row.config) as Record<string, unknown>) : null,
})

export const createSync =
  ({
    upstreams,
    tools,
    catalog,
    adapters,
    credentialOf,
  }: {
    upstreams: UpstreamsRepo
    tools: ToolsRepo
    catalog: CatalogRepo
    adapters: Adapters
    credentialOf: (id: string) => Promise<Credential | undefined>
  }) =>
  async (id: string): Promise<SyncSummary> => {
    const upstream = await upstreams.get(id)
    if (!upstream) throw new ProblemError('not_found', { detail: `No upstream ${id}. GET /api/upstreams lists them.` })
    const listing = await adapters
      .for(upstream.kind)
      .list(endpointOf(upstream), await credentialOf(id))
      .catch(async (error: unknown) => {
        await upstreams.markFailing(id, error instanceof Error ? error.message : String(error))
        throw error
      })
    const first = !upstream.syncedAt
    const autoLive = first || upstream.trust === 'trusted'
    const known = new Map((await tools.ofUpstream(id)).map((row) => [row.remoteName, row]))
    // A server that lists nothing where it had tools is far more often broken than emptied: keep what it had
    const serving = [...known.values()].filter((row) => !row.removedAt && row.liveVersion).length
    if (!listing.tools.length && serving && upstream.kind !== 'composio') {
      const detail = `${id} listed no tools, where it had ${serving}: kept them. If it really has none now, remove the connection.`
      await upstreams.markFailing(id, detail)
      throw new ProblemError('upstream', { detail })
    }
    const summary: Omit<SyncSummary, 'catalog'> = { added: [], changed: [], pending: [], removed: [], restored: [] }

    for (const remote of listing.tools) {
      const name = toolNameOf(id, remote.name)
      const definition: ToolDefinition = {
        title: remote.title,
        description: remote.description,
        inputSchema: remote.inputSchema,
        outputSchema: remote.outputSchema,
        annotations: remote.annotations,
      }
      const row = known.get(remote.name)
      known.delete(remote.name)
      const route = remote.route ?? null
      if (row && row.route !== route) await tools.setRoute(name, route)
      if (!row) {
        await tools.create({ name, upstreamId: id, remoteName: remote.name })
        if (route) await tools.setRoute(name, route)
        const versionId = await tools.addVersion(name, definition, 'pending')
        if (autoLive) {
          await tools.makeLive(name, versionId)
          summary.added.push(name)
        } else summary.pending.push(name)
        continue
      }
      const hash = hashDefinition(definition)
      const versions = await tools.versionsOf(name)
      const live = versions.find((version) => version.id === row.liveVersion)
      if (live?.hash === hash) {
        if (row.removedAt) {
          await tools.restore(name)
          summary.restored.push(name)
        }
        continue
      }
      // Already waiting for review, or refused before: nothing new to decide
      if (
        versions.some(
          (version) => version.hash === hash && (version.state === 'pending' || version.state === 'rejected'),
        )
      )
        continue
      const versionId = await tools.addVersion(name, definition, 'pending')
      if (autoLive) {
        await tools.makeLive(name, versionId)
        summary.changed.push(name)
      } else summary.pending.push(name)
    }

    for (const gone of known.values())
      if (!gone.removedAt) {
        await tools.markRemoved(gone.name)
        summary.removed.push(gone.name)
      }

    const toolCount = (await tools.ofUpstream(id)).filter((row) => !row.removedAt && row.liveVersion).length
    const catalogSummary = await reconcileCatalog({ catalog, upstreamId: id, listing: listing.catalog, autoLive })
    await upstreams.markSynced(id, { instructions: listing.instructions, server: listing.server, toolCount })
    return { ...summary, catalog: catalogSummary }
  }

export type Sync = ReturnType<typeof createSync>
