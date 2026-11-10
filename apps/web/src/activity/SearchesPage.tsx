/**
 * Activity › Searches: every tool search agents made, what it found, and the tool they called next. A search nothing
 * came of is a gap to close: find the tool yourself, connect what's missing, or reword a tool in a pack.
 */
import { IconArrowRight } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { RANGES, type Range } from '@/shell/filters.rules'
import { ScopePicker } from '@/shell/ScopePicker'
import { scopeFilter, useScope } from '@/shell/scope'
import { Mono } from '@/ui/Code'
import { Empty } from '@/ui/Empty'
import { FilterBar, RangePick } from '@/ui/FilterBar'
import { ago } from '@/ui/format'
import { Page } from '@/ui/Page'
import { Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { ActivityTabs } from './ActivityTabs'
import { searchesQuery } from './queries'

export type SearchesSearch = { range?: Range; unanswered?: true }

export const parseSearchesSearch = (raw: Record<string, unknown>): SearchesSearch => ({
  range: RANGES.some((range) => range.value === raw.range) ? (raw.range as Range) : undefined,
  unanswered: raw.unanswered === true || raw.unanswered === 'true' ? true : undefined,
})

const DAYS: Record<Range, number> = { '24h': 1, '7d': 7, '30d': 30 }

export const SearchesPage = ({ search }: { search: SearchesSearch }) => {
  const navigate = useNavigate()
  const { scope } = useScope()
  const set = (change: Partial<SearchesSearch>) =>
    void navigate({ to: '/activity/searches', search: { ...search, ...change }, replace: true })
  const range = search.range ?? '7d'
  const log = useQuery(
    searchesQuery({
      days: DAYS[range],
      ...scopeFilter(scope),
      ...(search.unanswered ? { unanswered: 'true' as const } : {}),
    }),
  )
  const rows = log.data?._embedded.searches ?? []
  return (
    <>
      <FilterBar refresh={[['searches']]}>
        <RangePick value={range} onChange={(next) => set({ range: next === '7d' ? undefined : next })} />
        <div className="inline-flex border border-border bg-card">
          {[
            { value: undefined, label: 'All searches' },
            { value: true as const, label: 'Nothing came of it' },
          ].map((choice) => (
            <button
              key={choice.label}
              type="button"
              aria-pressed={search.unanswered === choice.value}
              onClick={() => set({ unanswered: choice.value })}
              className="h-8 border-r border-border px-2.5 text-xs text-muted-foreground last:border-r-0 hover:text-foreground aria-pressed:bg-mist aria-pressed:text-foreground"
            >
              {choice.label}
            </button>
          ))}
        </div>
        <ScopePicker />
      </FilterBar>
      <Page className="pt-6">
        <ActivityTabs active="searches" />
        {log.isPending ? (
          <Skeleton className="h-80 rounded-none" />
        ) : log.error ? (
          <p className="text-sm text-error">{log.error.message}</p>
        ) : rows.length ? (
          <div className="overflow-x-auto border border-border bg-card">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs tracking-wide text-muted-foreground uppercase">
                  <th className="px-4 py-3 font-normal">Searched</th>
                  <th className="px-4 py-3 font-normal">Agent</th>
                  <th className="px-4 py-3 font-normal">Found</th>
                  <th className="px-4 py-3 font-normal">Then called</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-border align-top last:border-b-0">
                    <td className="px-4 py-3">
                      <span className="flex flex-col gap-0.5">
                        <span>“{row.query}”</span>
                        <span className="text-xs text-muted-foreground">{ago(row.at)}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.client}</td>
                    <td className="px-4 py-3">
                      {row.results ? (
                        <span className="flex flex-col gap-0.5">
                          <span className="text-xs text-muted-foreground">{row.results} tools, best first</span>
                          {row.tools.slice(0, 3).map((tool) => (
                            <Mono key={tool} className="truncate text-xs">
                              {tool}
                            </Mono>
                          ))}
                        </span>
                      ) : (
                        <Status tone="warn">Nothing</Status>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {row.followedBy ? (
                        <Link to="/tools/$name" params={{ name: row.followedBy }} className="hover:underline">
                          <Mono className="text-xs">{row.followedBy}</Mono>
                        </Link>
                      ) : (
                        <span className="flex flex-wrap items-center gap-2">
                          <Status tone="neutral">Nothing</Status>
                          <Button asChild variant="link" size="xs">
                            <Link to="/tools" search={{ q: row.query }}>
                              Find it yourself <IconArrowRight />
                            </Link>
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            illustration="nothing-found"
            title={search.unanswered ? 'Every search led to a call' : 'No searches yet'}
          >
            {search.unanswered
              ? 'Agents found what they looked for in this window.'
              : 'When an agent searches for a tool, it shows here with what it found and what it called next.'}
          </Empty>
        )}
      </Page>
    </>
  )
}
