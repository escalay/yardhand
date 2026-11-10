/** The tool list's filters in the address, and what each access setting means in words. */
import type { ToolCard } from '@/api/client'

export type ToolsSearch = {
  q?: string
  upstream?: string
  /** One group of that connection, by its key. */
  group?: string
  access?: 'reads' | 'changes' | 'off'
  pinned?: boolean
  /** See the list as this client would: its reach, scope, pack and wording. */
  as?: string
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined)

export const parseToolsSearch = (raw: Record<string, unknown>): ToolsSearch => ({
  q: text(raw.q),
  upstream: text(raw.upstream),
  group: text(raw.upstream) ? text(raw.group) : undefined,
  access: ['reads', 'changes', 'off'].includes(raw.access as string)
    ? (raw.access as ToolsSearch['access'])
    : undefined,
  pinned: raw.pinned === true || raw.pinned === 'true' || raw.pinned === 1 || raw.pinned === '1' ? true : undefined,
  as: typeof raw.as === 'string' && /^cl_[a-z0-9]{1,30}$/.test(raw.as) ? raw.as : undefined,
})

export const keep = (search: ToolsSearch) => (tool: ToolCard) =>
  (!search.access ||
    (search.access === 'off'
      ? tool.access === 'off'
      : tool.access !== 'off' && (search.access === 'changes') === tool.needsWrite)) &&
  (!search.pinned || tool.pinned) &&
  (!search.group || tool.group?.key === search.group)

/** The owner's three settings and "follow the server", in words. */
export const ACCESS = {
  auto: { label: 'Follow the server', body: 'Read-only when the server marks it so; otherwise it needs a write key.' },
  read: { label: 'Only reads', body: 'Any key may run it, read-only keys too.' },
  write: { label: 'Changes things', body: 'Only keys with write access may run it.' },
  off: { label: 'Switched off', body: 'Nobody runs it and only you see it, until you switch it back.' },
} as const

export type AccessChoice = keyof typeof ACCESS

export const choiceOf = (access: ToolCard['access']): AccessChoice => access ?? 'auto'

/** The groups among a connection's tools, in the order they first come. */
export const groupsAmong = (tools: Pick<ToolCard, 'group'>[]) => [
  ...new Map(tools.flatMap((tool) => (tool.group ? [[tool.group.key, tool.group]] : []))).values(),
]
