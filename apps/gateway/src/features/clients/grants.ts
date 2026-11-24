/**
 * OAuth clients are made when a sign-in is (the kit's `onGrant`, for a code, a device or a claim), never when a token
 * is first used: each new sign-in is its own row, whatever name its app gives, with the rights the owner approved at
 * the gateway's consent page (write, every upstream; the Agents page narrows it).
 */
import type { SignInGrant } from '../../kit/index.js'
import type { ClientsRepo } from './repo.js'

/**
 * The kit's `onGrant`: makes the row for this grant; false (nothing is issued) when it can't. A grant the start
 * already mapped (a claim approved before the update and collected after it) keeps its row.
 */
export const onGrantFor =
  ({ clients }: { clients: ClientsRepo }) =>
  async (grant: SignInGrant): Promise<boolean> => {
    if (await clients.byGrant(grant.grant)) return true
    return clients
      .create({
        name: grant.client.name,
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
