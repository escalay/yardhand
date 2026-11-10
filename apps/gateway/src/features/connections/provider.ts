/**
 * The gateway as an OAuth client of an upstream (Figma, Notion, Linear…): the MCP SDK runs discovery, registration,
 * PKCE and refresh; this provider keeps what it learns (client registration, tokens, verifier, state) sealed in the
 * vault as `oauth:<upstream>`, so a connection survives restarts and refreshes itself.
 */
import { randomBytes } from 'node:crypto'
import type { OAuthClientProvider } from '@modelcontextprotocol/client'
import type { Vault } from '../vault/repo.js'

type Stored = {
  client?: Awaited<ReturnType<NonNullable<OAuthClientProvider['clientInformation']>>>
  tokens?: Awaited<ReturnType<OAuthClientProvider['tokens']>>
  verifier?: string
  state?: string
}

export const connectionSecretOf = (upstreamId: string) => `oauth:${upstreamId}`

/** Where an upstream's authorization server sends the owner back: behind Access, like every approval page. */
export const callbackPath = '/app/connect/callback'

export const vaultOAuthProvider = ({
  vault,
  upstreamId,
  redirectUrl,
  onRedirect = () => {},
}: {
  vault: Vault
  upstreamId: string
  redirectUrl: string
  /** Gets the authorization URL when the owner has to approve; background connects pass nothing. */
  onRedirect?: (url: URL) => void
}): OAuthClientProvider => {
  const id = connectionSecretOf(upstreamId)
  const load = async () => (await vault.get<Stored>(id)) ?? {}
  const save = async (patch: Stored) => vault.put(id, { ...(await load()), ...patch })
  return {
    get redirectUrl() {
      return redirectUrl
    },
    get clientMetadata() {
      return {
        client_name: 'Yardhand',
        client_uri: new URL(redirectUrl).origin,
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }
    },
    // The state names the upstream, so the shared callback knows whose code it got
    state: async () => {
      const state = `${upstreamId}.${randomBytes(18).toString('base64url')}`
      await save({ state })
      return state
    },
    clientInformation: async () => (await load()).client,
    saveClientInformation: (client) => save({ client }),
    tokens: async () => (await load()).tokens,
    saveTokens: (tokens) => save({ tokens }),
    redirectToAuthorization: (url) => onRedirect(url),
    saveCodeVerifier: (verifier) => save({ verifier }),
    codeVerifier: async () => {
      const { verifier } = await load()
      if (!verifier)
        throw new Error(
          `No code verifier for ${upstreamId}: start again with POST /api/upstreams/${upstreamId}/connect`,
        )
      return verifier
    },
  }
}

/** The state this upstream's last connect started with, to check a callback against. */
export const expectedState = async (vault: Vault, upstreamId: string) =>
  (await vault.get<Stored>(connectionSecretOf(upstreamId)))?.state
