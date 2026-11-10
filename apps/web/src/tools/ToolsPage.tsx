/**
 * Tools: every tool behind the gateway, found by what it does (the same search agents use), narrowed by connection,
 * what it may do, or pinned; each opens to its schema and a place to try it.
 */
import { IconPin, IconPinnedFilled, IconSearch } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { reachOf } from '@/agents/agents.rules'
import { clientsQuery } from '@/agents/queries'
import { shortTitleOf } from '@/connections/connections.rules'
import { upstreamsQuery } from '@/connections/queries'
import { expiryOf } from '@/packs/packs.rules'
import { packQuery } from '@/packs/queries'
import { ScopePicker } from '@/shell/ScopePicker'
import { useScope } from '@/shell/scope'
import { Mono } from '@/ui/Code'
import { cn } from '@/ui/cn'
import { Empty } from '@/ui/Empty'
import { plural } from '@/ui/format'
import { Page, PageHeader } from '@/ui/Page'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/shadcn/select'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/shadcn/tooltip'
import { usePins } from './pins'
import { toolsQuery } from './queries'
import { ToolsTabs } from './ToolsTabs'
import { groupsAmong, keep, type ToolsSearch } from './tools.rules'

const ANY = '__any'
const ACCESS_FILTERS = [
  { value: undefined, label: 'All' },
  { value: 'reads', label: 'Only read' },
  { value: 'changes', label: 'Change things' },
  { value: 'off', label: 'Off' },
] as const

export const ToolsPage = ({ search }: { search: ToolsSearch }) => {
  const navigate = useNavigate()
  const set = (change: Partial<ToolsSearch>) =>
    void navigate({ to: '/tools', search: { ...search, ...change }, replace: true })
  const [words, setWords] = useState(search.q ?? '')
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((words.trim() || undefined) !== search.q) set({ q: words.trim() || undefined })
    }, 250)
    return () => clearTimeout(timer)
  })
  const { scope } = useScope()
  // An agent as the scope means "as it sees them"; a pack narrows the list to the pack's tools

  const pack = useQuery({ ...packQuery(scope.kind === 'pack' ? scope.name : ''), enabled: scope.kind === 'pack' })
  const inPack = scope.kind === 'pack' ? new Set(pack.data?.tools.map((tool) => tool.name) ?? []) : null
  const clients = useQuery(clientsQuery)
  const agents = (clients.data?._embedded.clients ?? []).filter(
    (row) => !row.revokedAt && !expiryOf(row.expiresAt).expired,
  )
  const as = search.as ?? (scope.kind === 'agent' && agents.some((row) => row.id === scope.id) ? scope.id : undefined)
  const tools = useQuery(toolsQuery({ q: search.q, upstream: search.upstream, as }))
  const seenAs = agents.find((row) => row.id === as)
  const upstreams = useQuery(upstreamsQuery)
  const pins = usePins()
  const shown = (tools.data?._embedded.tools ?? [])
    .filter(keep(search))
    .filter((tool) => !inPack || inPack.has(tool.name))
  const hidden = (tools.data?.count ?? 0) - shown.length
  const groups = search.upstream ? groupsAmong(tools.data?._embedded.tools ?? []) : []

  return (
    <Page>
      <PageHeader
        label="Tools"
        title={
          <>
            Everything agents <em>can</em> do
          </>
        }
        actions={
          <Select value={as ?? ANY} onValueChange={(value) => set({ as: value === ANY ? undefined : value })}>
            <SelectTrigger aria-label="See as" className="min-w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>See as you (everything)</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  See as {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        Search by what you want done, the way agents do. Pinned tools sit in every agent's tool list directly; the rest
        are one search away.
      </PageHeader>
      <ToolsTabs active={search.pinned ? 'pins' : 'tools'} />
      {seenAs ? (
        <p className="flex flex-wrap items-center gap-2 border border-primary/40 bg-mist px-4 py-3 text-sm">
          Seeing what <b className="font-medium">{seenAs.name}</b> sees: {reachOf(seenAs).toLowerCase()}
          {seenAs.pack ? ', in the pack’s own wording' : ''}. Searches here aren't logged.
          <Button variant="link" size="xs" className="ml-auto" onClick={() => set({ as: undefined })}>
            See as you
          </Button>
        </p>
      ) : inPack ? (
        <p className="border border-primary/40 bg-mist px-4 py-3 text-sm">
          Only the tools in the {scope.kind === 'pack' ? scope.title : ''} pack.
        </p>
      ) : null}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint-foreground" />
          <Input
            value={words}
            onChange={(event) => setWords(event.target.value)}
            placeholder="look up an order, send an email, create a ticket…"
            className="pl-9"
            aria-label="Search tools by what they do"
            autoFocus
          />
        </div>
        <ScopePicker />
        <Select
          value={search.upstream ?? ANY}
          onValueChange={(value) => set({ upstream: value === ANY ? undefined : value, group: undefined })}
        >
          <SelectTrigger aria-label="Connection" className="min-w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Every connection</SelectItem>
            {(upstreams.data?._embedded.upstreams ?? []).map((row) => (
              <SelectItem key={row.id} value={row.id}>
                {shortTitleOf(row.title)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {search.upstream && groups.length > 1 ? (
          <Select
            value={search.group ?? ANY}
            onValueChange={(value) => set({ group: value === ANY ? undefined : value })}
          >
            <SelectTrigger aria-label="Group" className="min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Every group</SelectItem>
              {groups.map((group) => (
                <SelectItem key={group.key} value={group.key}>
                  {group.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      <div className="-mt-3 flex flex-wrap items-center gap-1">
        {ACCESS_FILTERS.map((filter) => (
          <Button
            key={filter.label}
            size="sm"
            variant={search.access === filter.value ? 'muted' : 'ghost'}
            aria-pressed={search.access === filter.value}
            onClick={() => set({ access: filter.value })}
          >
            {filter.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant={search.pinned ? 'muted' : 'ghost'}
          aria-pressed={Boolean(search.pinned)}
          onClick={() => set({ pinned: search.pinned ? undefined : true })}
        >
          <IconPinnedFilled /> Pinned
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">
          {tools.data ? `${plural(shown.length, 'tool')}${search.q ? ', best match first' : ''}` : ''}
        </span>
      </div>

      {tools.isPending ? (
        <Skeleton className="h-96 rounded-none" />
      ) : tools.error ? (
        <Empty illustration="storm" title="Tools didn't load">
          {tools.error.message}
        </Empty>
      ) : shown.length ? (
        <ul
          className={cn('border-x border-t border-border bg-card transition-opacity', tools.isFetching && 'opacity-60')}
        >
          {shown.map((tool) => (
            <li key={tool.name} className="group flex items-center border-b border-border hover:bg-muted">
              <Link
                to="/tools/$name"
                params={{ name: tool.name }}
                className="grid min-w-0 flex-1 gap-1 px-4 py-3 sm:grid-cols-[18rem_minmax(0,1fr)] sm:gap-6"
              >
                <Mono
                  className={cn('truncate text-[13px]', tool.access === 'off' && 'text-faint-foreground line-through')}
                >
                  {tool.name}
                </Mono>
                <span className="truncate text-sm text-muted-foreground">{tool.summary}</span>
              </Link>
              <span className="hidden w-28 shrink-0 text-right text-xs text-faint-foreground md:block">
                {tool.access === 'off' ? 'off' : tool.needsWrite ? 'changes things' : 'reads'}
              </span>
              <span
                className="hidden w-16 shrink-0 text-right font-mono text-xs text-faint-foreground md:block"
                title="Calls in the last 7 days"
              >
                {tool.calls7d || ''}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={cn('mx-2', !tool.pinned && 'opacity-40 group-hover:opacity-100')}
                    aria-label={tool.pinned ? `Unpin ${tool.name}` : `Pin ${tool.name}`}
                    aria-pressed={tool.pinned}
                    disabled={pins.busy}
                    onClick={() => pins.toggle(tool.name)}
                  >
                    {tool.pinned ? <IconPinnedFilled className="text-primary" /> : <IconPin />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{tool.pinned ? 'Pinned for every agent' : 'Pin for every agent'}</TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      ) : search.q || search.access || search.pinned || search.upstream || search.group ? (
        <Empty
          illustration="nothing-found"
          title={search.pinned ? 'Nothing pinned yet' : 'No tool does that yet'}
          action={
            search.pinned ? (
              <Button variant="muted" onClick={() => set({ pinned: undefined })}>
                Show every tool
              </Button>
            ) : (
              <Button asChild variant="primary">
                <Link to="/connections/new">Connect something that does</Link>
              </Button>
            )
          }
        >
          {search.pinned
            ? 'Pin the tools agents use most and they show up in every tool list directly.'
            : hidden > 0
              ? `${plural(hidden, 'tool')} matched but are filtered out.`
              : 'Try other words, or connect a server that can.'}
        </Empty>
      ) : (
        <Empty
          illustration="tools"
          title="No tools yet"
          action={
            <Button asChild variant="primary">
              <Link to="/connections/new">Connect a server</Link>
            </Button>
          }
        >
          Tools come from connections. Add one and its tools show up here, ready to try.
        </Empty>
      )}
    </Page>
  )
}
