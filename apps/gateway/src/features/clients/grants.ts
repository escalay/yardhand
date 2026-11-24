/** OAuth client rows are made with their sign-in (the kit's `onGrant`), never on a token's first use. */
import type { SignInGrant } from '../../kit/index.js'
import type { ClientsRepo } from './repo.js'

/** The name an app gave, or `Unnamed app` for a blank one. */
export const nameOf = (given: string) => (given.trim() ? given : 'Unnamed app')

/** The kit's `onGrant`: makes this grant's row (write, every upstream), keeps one mapped already; false when it can't. */
export const onGrantFor =
  ({ clients }: { clients: ClientsRepo }) =>
  async (grant: SignInGrant): Promise<boolean> => {
    if (await clients.byGrant(grant.grant)) return true
    return clients
      .create({
        name: nameOf(grant.client.name),
        kind: 'oauth',
        oauthClientId: grant.client.id,
        scope: 'write',
        upstreams: 'all',
        grant: grant.grant,
      })
      .then(
        () => true,
        () => false,
      )
  }
