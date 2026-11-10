/**
 * The scope: everything, one pack, or one agent. It narrows Overview, Activity and Tools, and is picked in their filter
 * row; it is kept in this browser, since it follows the owner across those pages, while each page's own filters live
 * in the address.
 */
import { createContext, createElement, useContext, useState } from 'react'

export type Scope =
  | { kind: 'all' }
  | { kind: 'pack'; name: string; title: string }
  | { kind: 'agent'; id: string; name: string }

const KEY = 'gw.scope'
const ALL: Scope = { kind: 'all' }

const read = (): Scope => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Scope | null
    return raw && (raw.kind === 'pack' || raw.kind === 'agent') ? raw : ALL
  } catch {
    return ALL
  }
}

const ScopeContext = createContext<{ scope: Scope; setScope: (scope: Scope) => void }>({
  scope: ALL,
  setScope: () => {},
})

export const ScopeProvider = ({ children }: { children: React.ReactNode }) => {
  const [scope, set] = useState<Scope>(read)
  const setScope = (next: Scope) => {
    set(next)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {}
  }
  return createElement(ScopeContext.Provider, { value: { scope, setScope } }, children)
}

export const useScope = () => useContext(ScopeContext)

/** The API filter a scope means: `pack` for a pack, `client` for an agent. */
export const scopeFilter = (scope: Scope) =>
  scope.kind === 'pack' ? { pack: scope.name } : scope.kind === 'agent' ? { client: scope.id } : {}

/** Does the scope still point at something: a pack that exists, an agent whose key still works? */
export const scopeStillValid = (scope: Scope, live: { packs: string[]; agents: string[] }) =>
  scope.kind === 'all' || (scope.kind === 'pack' ? live.packs.includes(scope.name) : live.agents.includes(scope.id))

export const scopeLabel = (scope: Scope) =>
  scope.kind === 'pack' ? scope.title : scope.kind === 'agent' ? scope.name : 'Everything'

/** "pack", "agent", or nothing for everything. */
export const scopeKind = (scope: Scope) => (scope.kind === 'all' ? '' : scope.kind)
