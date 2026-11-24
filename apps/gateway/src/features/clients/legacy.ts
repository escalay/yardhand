/** Maps each sign-in from before 0.6.4, once, to the client row its name used: revoked rows end it, none makes one. */
import type { ClientsRepo } from './repo.js'

export const mapLegacySignIns = async ({
  clients,
  revokeGrant,
}: {
  clients: ClientsRepo
  revokeGrant: (grant: string) => Promise<unknown>
}) => {
  if (await clients.legacyMapped()) return
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
  await clients.markLegacyMapped(signIns.length)
}
