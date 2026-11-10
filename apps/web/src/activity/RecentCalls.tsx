/** The latest calls, new ones sliding in as they land; each opens in Activity. */
import { IconArrowRight } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { api, unwrap } from '@/api/client'
import { useLiveCalls } from '@/shell/live'
import { Section } from '@/ui/Page'
import { CallRow } from './CallRow'

export const RecentCalls = ({ limit = 8 }: { limit?: number }) => {
  const navigate = useNavigate()
  const recent = useQuery({
    queryKey: ['calls', 'recent', limit],
    queryFn: async () => (await unwrap(api.GET('/api/calls', { params: { query: { limit } } })))._embedded.calls,
  })
  const live = useLiveCalls()
  const liveIds = new Set(live.map((call) => call.id))
  const calls = [...live, ...(recent.data ?? []).filter((call) => !liveIds.has(call.id))].slice(0, limit)
  return (
    <Section
      title="Latest calls"
      aside={
        <Link
          to="/activity"
          search={{ outcome: 'all' }}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          All activity <IconArrowRight className="size-3.5" />
        </Link>
      }
    >
      {calls.length ? (
        <ul className="border-x border-t border-border bg-card">
          {calls.map((call) => (
            <CallRow
              key={call.id}
              call={call}
              fresh={liveIds.has(call.id)}
              onOpen={() => void navigate({ to: '/activity', search: { outcome: 'all', call: call.id } })}
            />
          ))}
        </ul>
      ) : (
        <p className="border border-border bg-card px-5 py-6 text-sm text-muted-foreground">
          No calls yet. They show up here the moment an agent makes one.
        </p>
      )}
    </Section>
  )
}
