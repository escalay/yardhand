/**
 * The scope picker: everything, one pack, or one agent. It sits only where it narrows the page (Overview, Tools,
 * Activity), in the filter row, with a way back to everything; a scope whose pack or key is gone falls back to it.
 */
import { IconCheck, IconChevronDown, IconX } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { clientsQuery } from '@/agents/queries'
import { expiryOf } from '@/packs/packs.rules'
import { packsQuery } from '@/packs/queries'
import { cn } from '@/ui/cn'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/shadcn/dropdown-menu'
import { type Scope, scopeKind, scopeLabel, scopeStillValid, useScope } from './scope'

const same = (a: Scope, b: Scope) =>
  a.kind === b.kind &&
  (a.kind !== 'pack' || (b.kind === 'pack' && a.name === b.name)) &&
  (a.kind !== 'agent' || (b.kind === 'agent' && a.id === b.id))

const Choice = ({ value, children }: { value: Scope; children: React.ReactNode }) => {
  const { scope, setScope } = useScope()
  return (
    <DropdownMenuItem onSelect={() => setScope(value)}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {same(scope, value) ? <IconCheck className="size-4" /> : null}
    </DropdownMenuItem>
  )
}

export const ScopePicker = () => {
  const { scope, setScope } = useScope()
  const packs = useQuery(packsQuery)
  const clients = useQuery(clientsQuery)
  const agents = (clients.data?._embedded.clients ?? []).filter(
    (row) => !row.revokedAt && !expiryOf(row.expiresAt).expired,
  )
  // A scope kept from before can outlive its target: an expired session key, a removed pack
  useEffect(() => {
    if (!packs.data || !clients.data) return
    const live = { packs: packs.data._embedded.packs.map((pack) => pack.name), agents: agents.map((agent) => agent.id) }
    if (!scopeStillValid(scope, live)) setScope({ kind: 'all' })
  })
  const narrowed = scope.kind !== 'all'
  return (
    <span
      className={cn(
        'inline-flex h-8 items-stretch border text-xs',
        narrowed ? 'border-primary/40 bg-mist' : 'border-border bg-card',
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Scope"
          className="inline-flex min-w-0 items-center gap-1.5 px-2.5 text-muted-foreground hover:text-foreground"
        >
          Showing
          <span
            aria-hidden="true"
            className={cn('size-1.5 rounded-full', narrowed ? 'bg-primary' : 'bg-faint-foreground')}
          />
          <span className="max-w-40 truncate text-foreground">{scopeLabel(scope)}</span>
          {narrowed ? <span className="text-faint-foreground">{scopeKind(scope)}</span> : null}
          <IconChevronDown className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[70vh] w-64 overflow-y-auto">
          <Choice value={{ kind: 'all' }}>Everything</Choice>
          {packs.data?._embedded.packs.length ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">Packs</DropdownMenuLabel>
                {packs.data._embedded.packs.map((pack) => (
                  <Choice key={pack.name} value={{ kind: 'pack', name: pack.name, title: pack.title }}>
                    {pack.title}
                  </Choice>
                ))}
              </DropdownMenuGroup>
            </>
          ) : null}
          {agents.length ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">Agents</DropdownMenuLabel>
                {agents.map((agent) => (
                  <Choice key={agent.id} value={{ kind: 'agent', id: agent.id, name: agent.name }}>
                    {agent.name}
                  </Choice>
                ))}
              </DropdownMenuGroup>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {narrowed ? (
        <button
          type="button"
          aria-label="Show everything"
          onClick={() => setScope({ kind: 'all' })}
          className="grid w-7 place-items-center border-l border-primary/30 text-muted-foreground hover:text-foreground"
        >
          <IconX className="size-3.5" />
        </button>
      ) : null}
    </span>
  )
}
