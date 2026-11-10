/** Waiting for a key's first call, live; the moment it lands, it says so and shows it. The activation moment. */
import { Link } from '@tanstack/react-router'
import { type CallEvent, useLiveCalls } from '@/shell/live'
import { Mono } from '@/ui/Code'
import { duration } from '@/ui/format'
import { Illustration } from '@/ui/Illustration'
import { OUTCOME, Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'

export const FirstCall = ({ clientId, name, since }: { clientId: string; name: string; since: string | null }) => {
  const calls = useLiveCalls((call: CallEvent) => call.clientId === clientId)
  const first = calls.at(-1)
  if (since && !first)
    return (
      <div className="flex items-center gap-3 border border-border bg-card p-5">
        <Status tone="ok">In use</Status>
        <span className="text-sm text-muted-foreground">Its calls are in Activity.</span>
      </div>
    )
  if (!first)
    return (
      <div className="flex items-center gap-5 border border-border bg-card p-5">
        <Illustration name="waiting" className="h-20 w-auto" />
        <div className="flex flex-col gap-1">
          <Status tone="live">Waiting for {name}'s first call</Status>
          <p className="text-sm text-pretty text-muted-foreground">
            Paste the setup, then ask the agent to find and run one of your tools, say “find a tool in gw and run it”.
            It shows up here the moment it happens.
          </p>
        </div>
      </div>
    )
  const outcome = OUTCOME[first.status] ?? { tone: 'neutral' as const, label: first.status }
  return (
    <div className="flex flex-col items-center gap-4 border border-primary/40 bg-mist/60 p-8 text-center">
      <Illustration name="celebrate" className="h-28 w-auto" />
      <h2 className="text-2xl tracking-tight">
        {name} is <em className="font-semibold italic">connected</em>
      </h2>
      <p className="text-sm text-muted-foreground">
        Its first call: <Mono>{first.tool}</Mono> · <Status tone={outcome.tone}>{outcome.label}</Status> ·{' '}
        {duration(first.durationMs)}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild variant="primary">
          <Link to="/activity" search={{ outcome: 'all', call: first.id }}>
            Open the call
          </Link>
        </Button>
        <Button asChild variant="muted">
          <Link to="/tools" search={{ pinned: true }}>
            Pin the tools it should see first
          </Link>
        </Button>
      </div>
    </div>
  )
}
