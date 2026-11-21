/** What the owner is told of a pack that is not there. Only the owner: a key never learns a pack's name from it. */
import type { PacksRepo } from './repo.js'

/** Why no pack has this name, and for a name a pack used to have, where it went. */
export const noPack = async (packs: Pick<PacksRepo, 'currentNameOf'>, name: string) => {
  const current = await packs.currentNameOf(name)
  return current
    ? `No pack ${name}: it was renamed to ${current}. GET /api/packs/${current}.`
    : `No pack ${name}. GET /api/packs lists them.`
}
