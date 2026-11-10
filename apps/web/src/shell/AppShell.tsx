/**
 * The frame around every screen: a floating sidebar on wide screens (the name, ⌘K, the six places with their counts,
 * reviews while something waits, live events, settings and the owner's menu), and on a phone a slim bar whose menu
 * opens the same sidebar as a drawer. Screens with numbers add their filter bar, scope included, at their top.
 */
import { IconLogout, IconMenu2, IconSearch, IconSettings, IconUser } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { api, unwrap } from '@/api/client'
import { packsQuery } from '@/packs/queries'
import { PRODUCT } from '@/setup/Wordmark'
import { cn } from '@/ui/cn'
import { Dot } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/shadcn/dropdown-menu'
import { Sheet, SheetContent, SheetTitle } from '@/ui/shadcn/sheet'
import { useLive } from './live'
import { TABS, tabOf } from './nav'
import { Palette, usePaletteShortcut } from './Palette'
import { overviewQuery, sessionQuery, systemQuery } from './queries'
import { ScopeProvider } from './scope'

const Wordmark = () => (
  <Link to="/" className="shrink-0 text-[13px] font-medium tracking-[0.22em] text-foreground uppercase">
    {PRODUCT}
  </Link>
)

/** The owner's menu: the version, and signing out. */
const OwnerMenu = () => {
  const system = useQuery(systemQuery)
  const session = useQuery(sessionQuery)
  const queries = useQueryClient()
  const signOut = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/session')),
    onSuccess: () => queries.invalidateQueries(),
  })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Owner menu" className="rounded-full">
          <span className="grid size-8 place-items-center rounded-full border border-border bg-mist">
            <IconUser className="size-4" />
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col font-normal">
          <span className="text-sm text-foreground">Owner</span>
          <span className="font-mono text-xs text-muted-foreground">
            {system.data ? `v${system.data.version}` : ''}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {session.data?.via === 'session' ? (
          <DropdownMenuItem onSelect={() => signOut.mutate()}>
            <IconLogout /> Sign out
          </DropdownMenuItem>
        ) : (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Signed in by Cloudflare Access.</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const itemClass = (current: boolean) =>
  cn(
    'flex h-9 items-center gap-3 px-3 text-sm transition-colors',
    current ? 'bg-mist font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  )

/** The sidebar's insides, the same on a wide screen and in the phone's drawer. */
const Sidebar = ({ onFind }: { onFind: () => void }) => {
  const path = useRouterState({ select: (state) => state.location.pathname })
  const overview = useQuery(overviewQuery)
  const packs = useQuery(packsQuery)
  const { connected } = useLive()
  const totals = overview.data?.totals
  const countOf = (to: string) =>
    to === '/connections'
      ? totals?.upstreams
      : to === '/tools'
        ? totals?.tools
        : to === '/packs'
          ? packs.data?.count
          : to === '/agents'
            ? totals?.clients
            : null
  const pending = totals?.pendingReviews ?? 0
  const active = tabOf(path)
  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className="flex h-10 items-center px-3">
        <Wordmark />
      </div>
      <button
        type="button"
        onClick={onFind}
        className="flex h-9 items-center gap-2 rounded-lg bg-background px-3 text-sm text-faint-foreground ring-1 ring-border ring-inset transition-shadow hover:ring-input"
      >
        <IconSearch className="size-4" />
        <span className="flex-1 text-left">Find anything</span>
        <kbd className="font-mono text-[11px]">⌘K</kbd>
      </button>
      <nav aria-label="Places" className="flex flex-col gap-0.5">
        {TABS.map((tab) => {
          const current = active === tab.to
          const count = countOf(tab.to)
          return (
            <Link
              key={tab.to}
              to={tab.to as never}
              {...(current ? { 'aria-current': 'page' as const } : {})}
              className={itemClass(current)}
            >
              <tab.icon className={cn('size-[18px] shrink-0', current ? 'text-primary' : '')} />
              <span className="flex-1">{tab.label}</span>
              {count ? <span className="font-mono text-[11px] text-faint-foreground">{count}</span> : null}
            </Link>
          )
        })}
      </nav>
      {pending ? (
        <Link
          to="/tools/reviews"
          className="flex items-center gap-2 border border-warn/40 bg-warn/10 px-3 py-2 text-sm hover:border-warn"
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-warn" />
          {pending} to review
        </Link>
      ) : null}
      <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-3">
        <Link
          to="/settings"
          aria-label="Settings"
          {...(active === '/settings' ? { 'aria-current': 'page' as const } : {})}
          className={itemClass(active === '/settings')}
        >
          <IconSettings className={cn('size-[18px]', active === '/settings' ? 'text-primary' : '')} />
          <span aria-hidden="true">Settings</span>
        </Link>
        <div className="flex items-center justify-between gap-2 pr-1 pl-3">
          <span
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            title={connected ? 'Pages update as calls and changes happen' : 'Reconnecting to live events'}
          >
            <Dot tone={connected ? 'live' : 'neutral'} />
            {connected ? 'Live' : 'Reconnecting…'}
          </span>
          <OwnerMenu />
        </div>
      </div>
    </div>
  )
}

export const AppShell = ({ children }: { children: React.ReactNode }) => {
  const [open, setOpen] = usePaletteShortcut()
  const [menu, setMenu] = useState(false)
  const find = () => {
    setMenu(false)
    setOpen(true)
  }
  return (
    <ScopeProvider>
      <div className="min-h-svh lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-svh p-3 pr-0 lg:block">
          <div className="h-full border border-border bg-card shadow-(--shadow-overlay)">
            <Sidebar onFind={find} />
          </div>
        </aside>
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-card/95 px-3 backdrop-blur lg:hidden">
          <Button variant="ghost" size="icon" aria-label="Open menu" onClick={() => setMenu(true)}>
            <IconMenu2 />
          </Button>
          <Wordmark />
          <Button variant="ghost" size="icon" aria-label="Find anything" className="ml-auto" onClick={find}>
            <IconSearch />
          </Button>
        </header>
        <Sheet open={menu} onOpenChange={setMenu}>
          <SheetContent side="left" className="w-72 p-0 sm:max-w-72">
            <SheetTitle className="sr-only">Menu</SheetTitle>
            {/* Going somewhere from the drawer closes it */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: the links inside are what is clicked */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: links answer Enter themselves */}
            <div
              className="h-full"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('a')) setMenu(false)
              }}
            >
              <Sidebar onFind={find} />
            </div>
          </SheetContent>
        </Sheet>
        <main className="min-w-0">{children}</main>
        <Palette open={open} onOpenChange={setOpen} />
      </div>
    </ScopeProvider>
  )
}
