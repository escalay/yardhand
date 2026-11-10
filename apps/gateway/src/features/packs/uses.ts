/**
 * Which tools a playbook uses, read from its text: tools it names (`seasonal_picks`, `cookbook.seasonal_picks`) and
 * routes it calls (`GET /api/v1/explore/seasonal?category=…`, matched against each tool's published route). Both are
 * certain, and only the playbook's own upstream counts: every archive has `list_menus`. Meaning suggestions come on
 * top, from search, and the owner confirms them.
 */
export type ToolForUses = { name: string; upstreamId: string; remoteName: string; route: string | null }
export type Use = { tool: string; reason: 'named' | 'route' | 'meaning' }

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const METHODS = 'GET|POST|PUT|PATCH|DELETE'

/** Every route the text calls, as `METHOD /path` (method null when the text gives none), query cut off. */
export const routesIn = (text: string) =>
  [...text.matchAll(new RegExp(`(?:\\b(${METHODS})\\s+)?(\\/api\\/[^\\s\`'")?#,]*)`, 'g'))].map((match) => ({
    method: match[1] ?? null,
    path: (match[2] ?? '').replace(/[.:;]+$/, ''),
  }))

/** A published route (`GET /api/v1/recipes/{id}`) as a matcher for written paths (`/api/v1/recipes/123`). */
const matcherOf = (route: string) => {
  const [method, path] = route.includes(' ') ? route.split(/\s+/, 2) : [null, route]
  if (!path) return null
  const pattern = new RegExp(`^${escapeRegex(path).replace(/\\\{[^}]+\\\}/g, '[^/]+')}/?$`)
  return (written: { method: string | null; path: string }) =>
    pattern.test(written.path) && (!written.method || !method || written.method === method.toUpperCase())
}

/** The tools of `upstreamId` a playbook's text names or calls by route, in the order the text first does. */
export const usesIn = (text: string, upstreamId: string, tools: ToolForUses[]): Use[] => {
  const own = tools.filter((tool) => tool.upstreamId === upstreamId)
  const written = routesIn(text)
  const found: (Use & { at: number })[] = []
  for (const tool of own) {
    // Not inside a path: `/api/v1/echo` calls a route, it doesn't name `echo`
    const named = new RegExp(
      `(?<![\\w/.-])(?:${escapeRegex(upstreamId)}\\.)?${escapeRegex(tool.remoteName)}(?![\\w/-])`,
    ).exec(text)
    if (named) {
      found.push({ tool: tool.name, reason: 'named', at: named.index })
      continue
    }
    const matches = tool.route ? matcherOf(tool.route) : null
    const hit = matches ? written.find(matches) : undefined
    if (hit) found.push({ tool: tool.name, reason: 'route', at: text.indexOf(hit.path) })
  }
  return found.sort((a, b) => a.at - b.at).map(({ tool, reason }) => ({ tool, reason }))
}

/** Meaning suggestions on top of the certain ones: at most `limit`, never one already found or already in. */
export const likelyUses = (ranked: string[], certain: Use[], already: Set<string>, limit = 5): Use[] => {
  const taken = new Set([...certain.map((use) => use.tool), ...already])
  return ranked
    .filter((name) => !taken.has(name))
    .slice(0, limit)
    .map((tool) => ({ tool, reason: 'meaning' as const }))
}
