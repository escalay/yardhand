/** Pure rules for adding a connection: what the probe found, said plainly, and what goes into the API. */
import type { Probe } from '@/api/client'

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

export type KeyStyle = 'bearer' | 'header'

/** The next thing the owner has to do after a look at a URL. */
export const stageOf = (probe: Probe | undefined) => {
  if (!probe) return 'address' as const
  if (!probe.reachable || (!probe.kind && probe.auth.needed !== 'key')) return 'unusable' as const
  if (probe.auth.needed === 'oauth') return 'oauth' as const
  if (probe.auth.needed === 'key' && !probe.auth.accepted) return 'key' as const
  if (probe.problem && !probe.toolCount) return 'unusable' as const
  return 'ready' as const
}

export const kindLabel = (kind: string | null | undefined) =>
  kind === 'http' ? 'REST API' : kind === 'mcp' ? 'MCP server' : 'Unknown'

/** The body for POST /api/upstreams from what the owner chose. */
export const draftOf = ({
  probe,
  id,
  title,
  trust,
  key,
}: {
  probe: Probe
  id: string
  title: string
  trust: 'trusted' | 'review'
  key: { style: KeyStyle; header: string; value: string } | null
}) => ({
  id,
  title: title.trim() || id,
  kind: probe.kind ?? 'mcp',
  url: probe.url,
  trust,
  enabled: true,
  linkProxy: true,
  auth:
    probe.auth.needed === 'oauth'
      ? { type: 'oauth' as const }
      : key?.value
        ? key.style === 'header'
          ? { type: 'header' as const, header: key.header || 'x-api-key', value: key.value }
          : { type: 'bearer' as const, value: key.value }
        : { type: 'none' as const },
  ...(probe.kind === 'http' && probe.http ? { http: { spec: probe.http.spec } } : {}),
})

/** How many of the previewed tools only read. */
export const readsOf = (probe: Probe) => probe.tools.filter((tool) => tool.readOnly).length

/**
 * A server's name for tight places (lists, menus): its title up to a colon, dash or bracket, when that leaves a name.
 * "notes: search and read (titles…)" → "notes", "Docs (docs.example.test)" → "Docs". Full titles stay on its own page.
 */
export const shortTitleOf = (title: string) => {
  const head = title.split(/:\s|\s[—–-]\s|\s\(/)[0]?.trim() ?? ''
  return head.length >= 2 ? head : title
}

export const CONNECTION_TABS = [
  'tools',
  'accounts',
  'manual',
  'playbooks',
  'links',
  'instructions',
  'activity',
] as const
export type ConnectionTab = (typeof CONNECTION_TABS)[number]

/** `?tab=` on a connection's page; anything else is its tools. */
export const parseConnectionTab = (raw: Record<string, unknown>): { tab?: ConnectionTab } =>
  CONNECTION_TABS.includes(raw.tab as ConnectionTab) && raw.tab !== 'tools' ? { tab: raw.tab as ConnectionTab } : {}

/** "manual, 10 playbooks, 5 links": what a server offers besides tools, or null when nothing. */
export const offersLine = (offers: { manuals: number; playbooks: number; links: number }) => {
  const parts = [
    offers.manuals ? (offers.manuals === 1 ? 'a manual' : `${offers.manuals} manuals`) : null,
    offers.playbooks ? `${offers.playbooks} playbook${offers.playbooks === 1 ? '' : 's'}` : null,
    offers.links ? `${offers.links} kind${offers.links === 1 ? '' : 's'} of link` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}
