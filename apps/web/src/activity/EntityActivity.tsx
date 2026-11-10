/**
 * The Activity tab of one connection, agent, pack or tool: its own calls, every kind, new ones live, each opening
 * beside the list; the whole log with the same filter is one click away.
 */
import { IconArrowRight } from '@tabler/icons-react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useLiveCalls } from '@/shell/live'
import { Empty } from '@/ui/Empty'
import { Button } from '@/ui/shadcn/button'
import { Skeleton } from '@/ui/shadcn/skeleton'
import type { ActivitySearch } from './activity.rules'
import { CallPanel } from './CallPanel'
import { CallRow } from './CallRow'
import { callsQuery } from './queries'

type Scope = Pick<ActivitySearch, 'upstream' | 'client' | 'tool' | 'pack'>

export const EntityActivity = ({ filter, clientIds }: { filter: Scope; clientIds?: string[] }) => {
  const [open, setOpen] = useState<string>()
  const search: Omit<ActivitySearch, 'call'> = { outcome: 'all', kind: 'all', ...filter }
  const calls = useInfiniteQuery(callsQuery(search, 30))
  const live = useLiveCalls(
    (event) =>
      (!filter.upstream || event.upstream === filter.upstream) &&
      (!filter.client || event.clientId === filter.client) &&
      (!filter.tool || event.tool === filter.tool) &&
      (!clientIds || clientIds.includes(event.clientId)),
  )
  const loaded = calls.data?.pages.flatMap((page) => page._embedded.calls) ?? []
  const liveIds = new Set(live.map((event) => event.id))
  const rows = [...live, ...loaded.filter((row) => !liveIds.has(row.id))]
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Link
          to="/activity"
          search={{ outcome: 'all', kind: 'all', ...filter }}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          In the whole log <IconArrowRight className="size-3.5" />
        </Link>
      </div>
      {calls.isPending ? (
        <Skeleton className="h-48 rounded-none" />
      ) : calls.error ? (
        <p className="text-sm text-error">{calls.error.message}</p>
      ) : rows.length ? (
        <>
          <ul className="border-x border-t border-border bg-card">
            {rows.map((row) => (
              <CallRow key={row.id} call={row} fresh={liveIds.has(row.id)} onOpen={() => setOpen(row.id)} />
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
          ) : null}
        </>
      ) : (
        <Empty illustration="waiting" title="No calls yet">
          Calls show up here the moment one is made, live.
        </Empty>
      )}
      <CallPanel id={open} onClose={() => setOpen(undefined)} />
    </div>
  )
}
