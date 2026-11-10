/**
 * Activity: every call, newest first, new ones sliding in live. Filters (outcome, connection, agent, door, tool) live in
 * the address; a call opens beside the list. The usual pattern for logs: time and filters first, detail in a drawer.
 */
import { IconX } from '@tabler/icons-react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { api, unwrap } from '@/api/client'
import { shortTitleOf } from '@/connections/connections.rules'
import { packQuery } from '@/packs/queries'
import { useLiveCalls } from '@/shell/live'
import { ScopePicker } from '@/shell/ScopePicker'
import { scopeFilter, useScope } from '@/shell/scope'
import { Mono } from '@/ui/Code'
import { Empty } from '@/ui/Empty'
import { DoorPick, FilterBar, RangePick } from '@/ui/FilterBar'
import { Page } from '@/ui/Page'
import { Button } from '@/ui/shadcn/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/shadcn/select'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { ActivityTabs } from './ActivityTabs'
import {
  type ActivitySearch,
  activeFilters,
  callsQueryOf,
  KIND_LABEL,
  type KindFilter,
  matches,
  type Outcome,
} from './activity.rules'
import { CallPanel } from './CallPanel'
import { CallRow } from './CallRow'
import { callsQuery } from './queries'
import { Running } from './Running'

const OUTCOMES: { value: Outcome; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'problems', label: "Didn't work" },
  { value: 'ok', label: 'OK' },
  { value: 'refused', label: 'Refused' },
]
const ANY = '__any'

const Pick = ({
  label,
  value,
  options,
  onChange,
  anyLabel,
}: {
  label: string
  value: string | undefined
  options: { value: string; label: string }[]
  onChange: (value: string | undefined) => void
  /** What no choice means, when it isn't "any". */
  anyLabel?: string
}) => (
  <Select value={value ?? ANY} onValueChange={(next) => onChange(next === ANY ? undefined : next)}>
    <SelectTrigger size="sm" aria-label={label} className="min-w-36">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value={ANY}>{anyLabel ?? `Any ${label.toLowerCase()}`}</SelectItem>
      {options.map((option) => (
        <SelectItem key={option.value} value={option.value}>
          {option.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
)

export const ActivityPage = ({ search }: { search: ActivitySearch }) => {
  const navigate = useNavigate()
  const set = (change: Partial<ActivitySearch>) =>
    void navigate({ to: '/activity', search: { ...search, ...change }, replace: true })
  const { scope } = useScope()
  const { call, ...own } = search
  // The top bar's scope narrows the log unless the address names an agent or a pack itself
  const filters = own.client || own.pack ? own : { ...own, ...scopeFilter(scope) }
  const calls = useInfiniteQuery(callsQuery(filters))
  const pack = useQuery({ ...packQuery(filters.pack ?? ''), enabled: Boolean(filters.pack) })
  const packKeys = new Set(pack.data?.keyList.map((key) => key.id) ?? [])
  const exportHref = `/api/calls/export?${new URLSearchParams(
    Object.entries(callsQueryOf(filters)).filter((entry): entry is [string, string] => Boolean(entry[1])),
  )}`
  const upstreams = useQuery({ queryKey: ['upstreams'], queryFn: () => unwrap(api.GET('/api/upstreams')) })
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => unwrap(api.GET('/api/clients')) })
  const live = useLiveCalls((event) => matches(filters, event) && (!filters.pack || packKeys.has(event.clientId)))
  const loaded = calls.data?.pages.flatMap((page) => page._embedded.calls) ?? []
  const liveIds = new Set(live.map((event) => event.id))
  const rows = [...live, ...loaded.filter((row) => !liveIds.has(row.id))]
  const narrowed = activeFilters(search) > 0

  return (
    <>
      <FilterBar exportHref={exportHref} refresh={[['calls']]}>
        <RangePick value={search.range} onChange={(range) => set({ range })} anyLabel="The whole log (90 days)" />
        <DoorPick value={search.via} onChange={(via) => set({ via })} />
        {search.pack ? (
          <Button variant="muted" size="sm" onClick={() => set({ pack: undefined })}>
            {search.pack} pack <IconX />
          </Button>
        ) : (
          <ScopePicker />
        )}
      </FilterBar>
      <Page className="pt-6">
        <ActivityTabs active={search.outcome === 'problems' ? 'problems' : 'calls'} />

        <Running />

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <fieldset className="m-0 flex gap-1 border-0 p-0">
            <legend className="sr-only">Outcome</legend>
            {OUTCOMES.map((outcome) => (
              <Button
                key={outcome.value}
                size="sm"
                variant={search.outcome === outcome.value ? 'muted' : 'ghost'}
                aria-pressed={search.outcome === outcome.value}
                onClick={() => set({ outcome: outcome.value })}
              >
                {outcome.label}
              </Button>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Pick
              label="Connection"
              value={search.upstream}
              onChange={(upstream) => set({ upstream })}
              options={(upstreams.data?._embedded.upstreams ?? []).map((row) => ({
                value: row.id,
                label: shortTitleOf(row.title),
              }))}
            />
            <Pick
              label="Agent"
              value={search.client}
              onChange={(client) => set({ client })}
              options={[
                { value: 'owner', label: 'You (owner)' },
                ...(clients.data?._embedded.clients ?? []).map((row) => ({ value: row.id, label: row.name })),
              ]}
            />
            <Pick
              label="Kind"
              anyLabel={KIND_LABEL.tool}
              value={search.kind}
              onChange={(kind) => set({ kind: kind as KindFilter | undefined })}
              options={(['manual', 'playbook', 'link', 'all'] as const).map((value) => ({
                value,
                label: KIND_LABEL[value] ?? value,
              }))}
            />
          </div>
        </div>
        {search.tool || narrowed ? (
          <div className="-mt-4 flex flex-wrap items-center gap-2 text-sm">
            {search.tool ? (
              <Button variant="muted" size="xs" onClick={() => set({ tool: undefined })}>
                <Mono>{search.tool}</Mono> <IconX />
              </Button>
            ) : null}
            <Button
              variant="link"
              size="xs"
              onClick={() => void navigate({ to: '/activity', search: { outcome: 'all' }, replace: true })}
            >
              Clear filters
            </Button>
          </div>
        ) : null}

        {calls.isPending ? (
          <Skeleton className="h-80 rounded-none" />
        ) : calls.error ? (
          <Empty
            illustration="storm"
            title="The log didn't load"
            action={<Button onClick={() => calls.refetch()}>Try again</Button>}
          >
            {calls.error.message}
          </Empty>
        ) : rows.length ? (
          <div className="flex flex-col gap-4">
            <ul className="border-x border-t border-border bg-card">
              {rows.map((row) => (
                <CallRow key={row.id} call={row} fresh={liveIds.has(row.id)} onOpen={() => set({ call: row.id })} />
              ))}
            </ul>
            {calls.hasNextPage ? (
              <Button
                variant="muted"
                className="self-center"
                disabled={calls.isFetchingNextPage}
                onClick={() => calls.fetchNextPage()}
              >
                {calls.isFetchingNextPage ? 'Loading…' : 'Older calls'}
              </Button>
            ) : (
              <p className="text-center text-xs text-faint-foreground">
                That's everything in the log (it keeps 90 days).
              </p>
            )}
          </div>
        ) : narrowed ? (
          <Empty
            illustration="nothing-found"
            title="No calls like that"
            action={
              <Button variant="muted" onClick={() => void navigate({ to: '/activity', search: { outcome: 'all' } })}>
                Clear filters
              </Button>
            }
          >
            {search.outcome === 'problems' ? 'Nothing failed here. ' : ''}Widen the filters, or wait: new calls appear
            here live.
          </Empty>
        ) : (
          <Empty illustration="waiting" title="Waiting for the first bite">
            Calls show up here the moment an agent makes one. Give an agent a key and paste its setup to start.
          </Empty>
        )}
        <CallPanel id={call} onClose={() => set({ call: undefined })} />
      </Page>
    </>
  )
}
