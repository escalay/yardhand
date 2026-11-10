/**
 * What a pack key opens besides its tools: only the links its tools' results handed it (for a day). A key locked to a
 * pack would otherwise read everything on its upstreams' hosts through the link proxy, and every link they serve.
 */

import { schemeOf } from '../catalog/manual.js'
import type { CatalogRepo } from '../catalog/repo.js'
import type { Principal } from '../clients/principals.js'
import { proxyBase } from './links.js'
import type { CallsRepo } from './repo.js'

const proxyKey = (upstreamId: string, path: string) => `proxy:${upstreamId}:${path}`
const linkKey = (upstreamId: string, uri: string) => `link:${upstreamId}:${uri}`

const stringsOf = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringsOf)
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(stringsOf)
        : []

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A link ends at white space, a quote or a bracket's close; the punctuation a sentence puts after it is not part of it
const REST = '[^\\s"\'<>`\\\\]*'
const trimmed = (link: string) => link.replace(/[).,;:!?\]]+$/, '')

/** The path (with its query) a proxied link asks the upstream for, as the proxy reads it. */
export const proxiedPath = (url: URL, upstreamId: string) =>
  url.pathname.slice(`/u/${upstreamId}/r/`.length).replace(/^\/+/, '') + url.search

/** Every link in a value that opens through the gateway: proxied URLs, and URIs of the schemes the upstream serves. */
export const linksIn = (
  value: unknown,
  { gatewayOrigin, upstreamId, schemes }: { gatewayOrigin: string | undefined; upstreamId: string; schemes: string[] },
) => {
  const texts = stringsOf(value)
  const found: string[] = []
  if (gatewayOrigin) {
    const proxied = new RegExp(`${escaped(proxyBase(gatewayOrigin, upstreamId))}${REST}`, 'g')
    for (const text of texts)
      for (const [match] of text.matchAll(proxied)) {
        const url = URL.parse(trimmed(match))
        if (url) found.push(proxyKey(upstreamId, proxiedPath(url, upstreamId)))
      }
  }
  if (schemes.length) {
    const served = new RegExp(`(?:${schemes.map(escaped).join('|')})://${REST}`, 'g')
    for (const text of texts)
      for (const [match] of text.matchAll(served)) found.push(linkKey(upstreamId, trimmed(match)))
  }
  return found
}

export const createHanded = ({ calls, catalog }: { calls: CallsRepo; catalog: CatalogRepo }) => {
  const schemesOf = async (upstreamId: string) => [
    ...new Set(
      (await catalog.listLive({ kinds: ['template', 'resource'], upstreams: [upstreamId] }))
        .map((link) => schemeOf(link.remoteName))
        .filter((scheme): scheme is string => Boolean(scheme)),
    ),
  ]
  return {
    /** Notes the links in what a pack key was just sent; other callers need none noted. */
    note: async (principal: Principal, upstreamId: string, value: unknown, gatewayOrigin: string | undefined) => {
      if (!principal.pack) return
      const links = linksIn(value, { gatewayOrigin, upstreamId, schemes: await schemesOf(upstreamId) })
      if (links.length) await calls.hand(principal.id, links)
    },
    /** May it open this path on the upstream's host through the proxy? */
    opensPath: async (principal: Principal, upstreamId: string, path: string) =>
      !principal.pack || calls.wasHanded(principal.id, proxyKey(upstreamId, path)),
    /** May it read this link the upstream serves? */
    readsLink: async (principal: Principal, upstreamId: string, uri: string) =>
      !principal.pack || calls.wasHanded(principal.id, linkKey(upstreamId, uri)),
  }
}

export type Handed = ReturnType<typeof createHanded>
