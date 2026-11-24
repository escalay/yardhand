/**
 * The one start that maps every sign-in made before 0.6.4 to the client row it used then, found by the name its app
 * gave. Sign-ins sharing a name keep sharing one row, so its pins, allowlist, pack and end apply to all of them as
 * before. A sign-in of a revoked row is ended at the kit; one whose app never called gets the row its first call would
 * have made. Recorded in the vault, so it runs once; after it no request matches a name to a sign-in.
 */
import type { Vault } from '../vault/repo.js'
import type { ClientsRepo } from './repo.js'

export const LEGACY_MAPPED = 'clients:legacy-mapped'

export const mapLegacySignIns = async ({
  clients,
  vault,
  revokeGrant,
}: {
  clients: ClientsRepo
  vault: Vault
  revokeGrant: (grant: string) => Promise<unknown>
}) => {
  if (await vault.get(LEGACY_MAPPED)) return
  const signIns = await clients.kitSignIns()
  for (const { grant, client, name } of signIns) {
    const row = await clients.byOAuthName(name)
    if (row?.revokedAt) await revokeGrant(grant)
    else if (row) await clients.mapGrant(grant, row.id, true)
    else {
      const id = await clients.create({
        name,
        kind: 'oauth',
        oauthName: name,
        oauthClientId: client,
        scope: 'write',
        upstreams: 'all',
      })
      await clients.mapGrant(grant, id, true)
    }
  }
  await vault.put(LEGACY_MAPPED, { at: new Date().toISOString(), signIns: signIns.length })
}
