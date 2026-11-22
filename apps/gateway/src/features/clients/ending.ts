/** Whose access to a pack is ending: what Home's nudge and the webhook notice both read. */
import type { Services } from '../../services.js'
import { standingOf } from './lifetimes.js'

export type EndingAccess = { id: string; name: string; pack: { name: string; title: string }; expiresAt: string }

/**
 * Every client in its last three days (`standingOf`), with its default pack, or the first pack it still opens when
 * that one was removed, soonest first. A key outside a pack, or whose packs were all removed, is left out.
 */
export const endingAccess = async (
  { clients, packs }: Pick<Services, 'clients' | 'packs'>,
  now = new Date(),
): Promise<EndingAccess[]> => {
  const [rows, all] = await Promise.all([clients.list(), packs.list()])
  const packOf = new Map(all.map((pack) => [pack.id, pack]))
  const packFor = async (row: (typeof rows)[number]) =>
    (row.packId && packOf.get(row.packId)) ||
    (await clients.packsOf(row)).flatMap((packId) => packOf.get(packId) ?? [])[0]
  const ending = await Promise.all(
    rows
      .filter((row) => row.expiresAt && standingOf(row, now) === 'ending')
      .map(async (row) => {
        const pack = await packFor(row)
        return pack && row.expiresAt
          ? [{ id: row.id, name: row.name, pack: { name: pack.name, title: pack.title }, expiresAt: row.expiresAt }]
          : []
      }),
  )
  return ending.flat().sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.id.localeCompare(b.id))
}
