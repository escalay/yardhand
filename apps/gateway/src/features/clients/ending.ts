/** Whose access to a pack is ending: what Home's nudge and the webhook notice both read. */
import type { Services } from '../../services.js'
import { standingOf } from './lifetimes.js'

export type EndingAccess = { id: string; name: string; pack: { name: string; title: string }; expiresAt: string }

/**
 * Every client in its last three days (`standingOf`), with its default pack, soonest first. A key outside a pack, or
 * whose pack was removed, is left out.
 */
export const endingAccess = async (
  { clients, packs }: Pick<Services, 'clients' | 'packs'>,
  now = new Date(),
): Promise<EndingAccess[]> => {
  const [rows, all] = await Promise.all([clients.list(), packs.list()])
  const packOf = new Map(all.map((pack) => [pack.id, pack]))
  return rows
    .flatMap((row) => {
      const pack = row.packId ? packOf.get(row.packId) : undefined
      return pack && row.expiresAt && standingOf(row, now) === 'ending'
        ? [{ id: row.id, name: row.name, pack: { name: pack.name, title: pack.title }, expiresAt: row.expiresAt }]
        : []
    })
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.id.localeCompare(b.id))
}
