/**
 * Links in a result that point at the upstream's own host can't be opened with a gateway key. They are rewritten to
 * the gateway's read-only proxy for that upstream (`/u/{id}/r/<path>`), which fetches them with the stored credential.
 */

/** Every string in a value, rewritten; the shape is kept. */
const mapStrings = (value: unknown, rewrite: (text: string) => string): unknown => {
  if (typeof value === 'string') return rewrite(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, rewrite))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, rewrite)]))
  return value
}

/** The proxy path an upstream's links move to. */
export const proxyBase = (gatewayOrigin: string, upstreamId: string) => `${gatewayOrigin}/u/${upstreamId}/r/`

/** Rewrites `https://<upstream host>/…` to the gateway proxy, everywhere in the result. */
export const rewriteLinks = <T>(
  result: T,
  { upstreamUrl, upstreamId, gatewayOrigin }: { upstreamUrl: string; upstreamId: string; gatewayOrigin: string },
): T => {
  const origin = new URL(upstreamUrl).origin
  const pattern = new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'g')
  const target = proxyBase(gatewayOrigin, upstreamId)
  return mapStrings(result, (text) => (text.includes(origin) ? text.replace(pattern, target) : text)) as T
}
