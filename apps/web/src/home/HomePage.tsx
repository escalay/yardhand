/**
 * Overview, the hub. Its head says what is behind the one address and gives the address to copy. Until setup is done:
 * the next step, with the guided setup a click away. Always: what needs the owner. With calls: the filter bar (window, door, compare, scope), tiles with their change
 * since the window before, calls by outcome, and ranked tools, agents, connections and searches nothing answered.
 */
import { IconArrowRight } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { RecentCalls } from '@/activity/RecentCalls'
import type { Overview, Schemas } from '@/api/client'
import { shortTitleOf } from '@/connections/connections.rules'
import { TelemetryNotice } from '@/settings/TelemetryNotice'
import { changeOf, percent, RANGES, shareOf } from '@/shell/filters.rules'
import { overviewQuery, systemQuery } from '@/shell/queries'
import { ScopePicker } from '@/shell/ScopePicker'
import { scopeFilter, useScope } from '@/shell/scope'
import { Mono } from '@/ui/Code'
import { CopyButton } from '@/ui/Copy'
import { cn } from '@/ui/cn'
import { CompareSwitch, DoorPick, FilterBar, RangePick } from '@/ui/FilterBar'
import { duration, plural } from '@/ui/format'
import { Page, Section } from '@/ui/Page'
import { Dot, HEALTH, Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { CallsChart } from './CallsChart'
import { Checklist } from './Checklist'
import { type OverviewSearch, routeOf } from './home.rules'
import { statsQuery } from './queries'

/** The page's head: what is behind the one address, and the address itself to copy into an agent. */
const Head = ({ overview }: { overview: Overview }) => {
  const system = useQuery(systemQuery)
  const { totals } = overview
  const address = system.data ? `${system.data.publicOrigin}/mcp` : null
  return (
    <header className="flex flex-col gap-4 border-b border-border pb-6 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex flex-col gap-2">
        <span className="text-xs tracking-wide text-muted-foreground uppercase">{'/// '}Overview</span>
        <h1 className="text-3xl tracking-tight text-balance sm:text-4xl">
          {totals.tools ? (
            <>
              {plural(totals.tools, 'tool')} from {plural(totals.live, 'server')}, <em>one address</em>
            </>
          ) : (
            <>
              Welcome to <em>Yardhand</em>
            </>
          )}
        </h1>
        <p className="max-w-xl text-sm text-pretty text-muted-foreground">
          {totals.tools
            ? `${plural(totals.clients, 'agent')} can reach them. Every call goes through here and lands in Activity.`
            : 'Connect a server once and every agent you allow can use its tools, with the keys kept here and every call on the record.'}
        </p>
      </div>
      {address ? (
        <div className="flex min-w-0 flex-col gap-1.5 lg:items-end">
          <span className="text-xs text-muted-foreground">Agents connect to</span>
          <div className="flex min-w-0 items-center gap-2 border border-border bg-card py-1 pr-1 pl-3">
            <Mono className="min-w-0 truncate text-[13px]">{address}</Mono>
            <CopyButton text={address} label="Copy" size="xs" variant="ghost" />
          </div>
        </div>
      ) : null}
    </header>
  )
}

const Nudges = ({ nudges }: { nudges: Overview['nudges'] }) =>
  nudges.length ? (
    <Section title="Needs you">
      <ul className="border border-border bg-card">
        {nudges.map((nudge) => (
          <li
            key={`${nudge.kind}${nudge.href}`}
            className="flex items-center gap-4 border-b border-border px-5 py-3.5 last:border-b-0"
          >
            <Status
              tone={nudge.kind === 'failing_upstream' ? 'error' : nudge.kind === 'reviews' ? 'warn' : 'neutral'}
              className="sr-only"
            >
              {nudge.kind}
            </Status>
            <p className="flex-1 text-sm text-pretty">{nudge.message}</p>
            <Button asChild variant="muted" size="sm">
              <Link to={routeOf(nudge.href) as never}>{nudge.action}</Link>
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  ) : null

const Tile = ({
  label,
  value,
  change,
  compare,
}: {
  label: string
  value: string
  change: ReturnType<typeof changeOf>
  compare: boolean
}) => (
  <div className="flex min-w-0 flex-col gap-1 border-r border-b border-border bg-card p-3 sm:p-5">
    <span className="truncate text-xs tracking-wide text-muted-foreground uppercase">{label}</span>
    <span className="text-2xl tracking-tight tabular-nums sm:text-3xl">{value}</span>
    {compare && change.text !== 'nothing to compare' && change.text !== 'none the window before' ? (
      <span
        className={cn(
          'font-mono text-xs',
          change.tone === 'good' ? 'text-ok' : change.tone === 'bad' ? 'text-error' : 'text-muted-foreground',
        )}
      >
        {change.text}
      </span>
    ) : null}
  </div>
)

type Stats = Schemas['OverviewStats']

const Tiles = ({ stats, compare }: { stats: Stats; compare: boolean }) => {
  const { now, before } = stats.tiles
  const share = (tile: Stats['tiles']['now']) => shareOf(tile.problems, tile.calls)
  const found = (tile: Stats['tiles']['now']) => shareOf(tile.found, tile.searches)
  return (
    <div className="grid grid-cols-2 border-t border-l border-border lg:grid-cols-4">
      <Tile
        label="Calls"
        value={now.calls.toLocaleString('en-GB')}
        change={changeOf(now.calls, before.calls)}
        compare={compare}
      />
      <Tile
        label="Didn't work"
        value={percent(share(now))}
        change={changeOf(share(now), share(before), { lowerIsBetter: true, points: true })}
        compare={compare}
      />
      <Tile
        label="Found what it searched"
        value={percent(found(now))}
        change={changeOf(found(now), found(before), { points: true })}
        compare={compare}
      />
      <Tile
        label="Median time"
        value={now.medianMs === null ? '–' : duration(now.medianMs)}
        change={changeOf(now.medianMs, before.medianMs, { lowerIsBetter: true })}
        compare={compare}
      />
    </div>
  )
}

/** A ranked list: a bar behind each row to its share of the top one. */
const Ranked = ({
  title,
  rows,
  empty,
  more,
}: {
  title: string
  rows: { key: string; label: React.ReactNode; value: string; share: number; problems?: number; to: React.ReactNode }[]
  empty: string
  more?: React.ReactNode
}) => (
  <Section title={title} aside={more}>
    <div className="flex flex-col gap-1.5 border border-border bg-card p-4">
      {rows.length ? (
        rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
            <div className="relative min-w-0">
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 bg-mist"
                style={{ width: `${Math.max(2, Math.round(row.share * 100))}%` }}
              />
              <span className="relative block truncate px-2 py-1">{row.to}</span>
            </div>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {row.value}
              {row.problems ? <span className="ml-2 text-error">{row.problems} ✕</span> : null}
            </span>
          </div>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  </Section>
)

const Numbers = ({ search, overview }: { search: OverviewSearch; overview: Overview }) => {
  const { scope } = useScope()
  const navigate = useNavigate()
  const set = (change: Partial<OverviewSearch>) =>
    void navigate({ to: '/', search: { ...search, ...change }, replace: true })
  const chosen = search.range ?? '7d'
  const compare = search.compare !== false
  const stats = useQuery(statsQuery({ range: chosen, via: search.via, ...scopeFilter(scope) }))
  const range = RANGES.find((option) => option.value === chosen) ?? RANGES[1]
  const titles = new Map(overview.upstreams.map((row) => [row.id, row]))
  const data = stats.data
  const top = (values: number[]) => Math.max(...values, 1)
  return (
    <>
      <FilterBar refresh={[['overview']]}>
        <RangePick value={chosen} onChange={(next) => set({ range: next === '7d' ? undefined : next })} />
        <DoorPick value={search.via} onChange={(via) => set({ via })} />
        <CompareSwitch checked={compare} onChange={(next) => set({ compare: next ? undefined : false })} />
        <ScopePicker />
      </FilterBar>
      <Page className="pt-6">
        {stats.error ? (
          <p className="text-sm text-error">{stats.error.message}</p>
        ) : !data ? (
          <Skeleton className="h-64 rounded-none" />
        ) : (
          <>
            <Tiles stats={data} compare={compare} />
            <Section title={`Calls, ${range.label.toLowerCase()}`}>
              <div className="border border-border bg-card p-5">
                <CallsChart buckets={data.series} by={data.bucket} window={range.label.toLowerCase()} />
              </div>
            </Section>
            <div className="grid gap-8 lg:grid-cols-2">
              <Ranked
                title="Most used tools"
                empty="No tool calls in this window."
                rows={data.tools.map((tool) => ({
                  key: tool.name,
                  label: tool.name,
                  value: tool.calls.toLocaleString('en-GB'),
                  share: tool.calls / top(data.tools.map((row) => row.calls)),
                  problems: tool.problems,
                  to: (
                    <Link
                      to="/tools/$name"
                      params={{ name: tool.name }}
                      className="font-mono text-[13px] hover:underline"
                    >
                      {tool.name}
                    </Link>
                  ),
                }))}
              />
              <Ranked
                title="Busiest agents"
                empty="No agent called in this window."
                rows={data.agents.map((agent) => ({
                  key: agent.id,
                  label: agent.name,
                  value: agent.calls.toLocaleString('en-GB'),
                  share: agent.calls / top(data.agents.map((row) => row.calls)),
                  problems: agent.problems,
                  to:
                    agent.id === 'owner' ? (
                      <span>You, in this app</span>
                    ) : (
                      <Link to="/agents/$id" params={{ id: agent.id }} className="hover:underline">
                        {agent.name}
                      </Link>
                    ),
                }))}
              />
              <Ranked
                title="Connections"
                empty="No calls reached a connection in this window."
                more={
                  <Link
                    to="/connections"
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    All <IconArrowRight className="size-3.5" />
                  </Link>
                }
                rows={data.upstreams.map((upstream) => {
                  const row = titles.get(upstream.id)
                  const health = row ? HEALTH[row.status] : undefined
                  return {
                    key: upstream.id,
                    label: upstream.id,
                    value: `${upstream.calls.toLocaleString('en-GB')} · ${duration(upstream.medianMs)}`,
                    share: upstream.calls / top(data.upstreams.map((entry) => entry.calls)),
                    problems: upstream.problems,
                    to: (
                      <Link
                        to="/connections/$id"
                        params={{ id: upstream.id }}
                        className="inline-flex items-center gap-2 hover:underline"
                      >
                        {health ? <Dot tone={row?.enabled ? health.tone : 'neutral'} /> : null}
                        {row ? shortTitleOf(row.title) : upstream.id}
                      </Link>
                    ),
                  }
                })}
              />
              <Ranked
                title="Searches nothing answered"
                empty="Every search in this window led to a call."
                more={
                  <Link
                    to="/activity/searches"
                    search={{ unanswered: true }}
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    All searches <IconArrowRight className="size-3.5" />
                  </Link>
                }
                rows={data.unanswered.map((entry) => ({
                  key: entry.query,
                  label: entry.query,
                  value: `${entry.count}×`,
                  share: entry.count / top(data.unanswered.map((row) => row.count)),
                  to: (
                    <span title={entry.clients.join(', ')}>
                      “{entry.query}” <span className="text-muted-foreground">· {entry.clients.join(', ')}</span>
                    </span>
                  ),
                }))}
              />
            </div>
            <RecentCalls limit={8} />
          </>
        )}
      </Page>
    </>
  )
}

export const HomePage = ({ search }: { search: OverviewSearch }) => {
  const overview = useQuery(overviewQuery)
  if (overview.isPending)
    return (
      <Page>
        <Skeleton className="h-64 w-full rounded-none" />
        <Skeleton className="h-40 w-full rounded-none" />
      </Page>
    )
  if (overview.error) throw overview.error
  const data = overview.data
  const setupOpen = !data.setup.complete
  return (
    <>
      <Page className={data.totals.upstreams ? 'pb-0 lg:pb-0' : undefined}>
        <Head overview={data} />
        <TelemetryNotice />
        {setupOpen ? <Checklist setup={data.setup} /> : null}
        <Nudges nudges={data.nudges} />
      </Page>
      {data.totals.upstreams ? <Numbers search={search} overview={data} /> : null}
    </>
  )
}
