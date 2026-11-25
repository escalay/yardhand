/** OAuth client rows are made with their sign-in (the kit's `onGrant`), never on a token's first use. */
import type { SignInGrant, SignInRevoked } from '../../kit/index.js'
import type { PacksRepo } from '../packs/repo.js'
import type { ClientDraft, ClientsRepo } from './repo.js'
import { classOfResource } from './resources.js'

/** The name an app gave, or `Unnamed app` for a blank one. */
export const nameOf = (given: string) => (given.trim() ? given : 'Unnamed app')

/** A sign-in at a pack's address: locked to the pack the name leads to, with the token's scope; none when no pack. */
const packDraftOf = async (packs: PacksRepo, name: string, scopes: string[]) => {
  const held = await packs.holderOf(name)
  if (!held) return null
  return {
    scope: scopes.includes('write') ? 'write' : 'read',
    // None of its own: a pack-locked row reaches its pack's upstreams, as a pack key does
    upstreams: [],
    packIds: [held.pack.id],
    packId: held.pack.id,
    joinedBy: 'owner',
  } satisfies Partial<ClientDraft>
}

/**
 * The kit's `onGrant`: makes the grant's row or keeps a mapped one; false when it can't. At the root (or with no
 * resource, from before audiences) write and every upstream; at a pack's address locked to that pack.
 */
export const onGrantFor =
  ({ clients, packs }: { clients: ClientsRepo; packs: PacksRepo }) =>
  async (grant: SignInGrant): Promise<boolean> => {
    if (await clients.byGrant(grant.grant)) return true
    const resource = grant.resource === undefined ? { kind: 'root' as const } : classOfResource(grant.resource)
    if (!resource) return false
    const rights =
      resource.kind === 'pack'
        ? await packDraftOf(packs, resource.name, grant.scopes)
        : { scope: 'write' as const, upstreams: 'all' as const }
    if (!rights) return false
    return clients
      .create({
        name: nameOf(grant.client.name),
        kind: 'oauth',
        oauthClientId: grant.client.id,
        grant: grant.grant,
        ...rights,
      })
      .then(
        () => true,
        () => false,
      )
  }

/**
 * The kit's `onRevoke`. A sign-in withdrawn before its first token (`onGrant` said yes, then it was ended or a write
 * failed) never became an agent: the row `onGrant` made for it goes. A grant ended later keeps its row, refused by
 * `rowOf` like any token the kit no longer takes; the owner revokes the row.
 */
export const onRevokeFor =
  ({ clients }: { clients: ClientsRepo }) =>
  async ({ grant, reason }: SignInRevoked) => {
    if (grant && reason === 'withdrawn') await clients.dropSignIn(grant)
  }
