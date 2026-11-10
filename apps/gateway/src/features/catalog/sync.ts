/**
 * Reconciles what an upstream offers besides tools with the catalog, by the same rules as tools: on the first sync and
 * from a `trusted` upstream new and changed items go live; from a `review` upstream they wait as `pending`. A kind the
 * upstream could not list this time (`null`) is left as it was.
 */
import {
  type CatalogContent,
  type CatalogListing,
  hashContent,
  itemIdOf,
  publicNameOf,
  remoteNameOf,
} from './content.js'
import type { CatalogRepo } from './repo.js'
import type { CatalogKind } from './schema.js'

export type CatalogSummary = { added: string[]; changed: string[]; pending: string[]; removed: string[] }

export const emptyCatalogSummary = (): CatalogSummary => ({ added: [], changed: [], pending: [], removed: [] })

const KINDS: [CatalogKind, keyof CatalogListing][] = [
  ['manual', 'manuals'],
  ['playbook', 'playbooks'],
  ['template', 'templates'],
  ['resource', 'resources'],
]

export const reconcileCatalog = async ({
  catalog,
  upstreamId,
  listing,
  autoLive,
}: {
  catalog: CatalogRepo
  upstreamId: string
  listing: CatalogListing
  autoLive: boolean
}): Promise<CatalogSummary> => {
  const summary = emptyCatalogSummary()
  const rows = await catalog.ofUpstream(upstreamId)
  for (const [kind, key] of KINDS) {
    const found = listing[key] as CatalogContent[] | null
    if (found === null) continue
    const known = new Map(rows.filter((row) => row.kind === kind).map((row) => [row.id, row]))
    for (const content of found) {
      const remoteName = remoteNameOf(content)
      const id = itemIdOf(upstreamId, kind, remoteName)
      const name = publicNameOf(upstreamId, content)
      const row = known.get(id)
      known.delete(id)
      if (!row) {
        await catalog.create({ id, upstreamId, kind, remoteName, name })
        const versionId = await catalog.addVersion(id, content, 'pending')
        if (autoLive) {
          await catalog.makeLive(id, versionId)
          summary.added.push(name)
        } else summary.pending.push(name)
        continue
      }
      const hash = hashContent(content)
      const versions = await catalog.versionsOf(id)
      const live = versions.find((version) => version.id === row.liveVersion)
      if (live?.hash === hash) {
        if (row.removedAt) await catalog.restore(id)
        continue
      }
      // Already waiting for review, or refused before: nothing new to decide
      if (
        versions.some((version) => version.hash === hash && version.state !== 'superseded' && version.state !== 'live')
      )
        continue
      const versionId = await catalog.addVersion(id, content, 'pending')
      if (autoLive) {
        await catalog.makeLive(id, versionId)
        summary.changed.push(name)
      } else summary.pending.push(name)
    }
    for (const gone of known.values())
      if (!gone.removedAt) {
        await catalog.markRemoved(gone.id)
        summary.removed.push(gone.name)
      }
  }
  return summary
}
