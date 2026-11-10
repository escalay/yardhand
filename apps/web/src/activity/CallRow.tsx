/** One call in a list: when, which tool, who, by which door, how it ended and how long it took. */
import type { CallRecord } from '@/api/client'
import { cn } from '@/ui/cn'
import { duration, when } from '@/ui/format'
import { OUTCOME, Status } from '@/ui/Status'
import { VIA_LABEL } from './activity.rules'

export type CallLike = Pick<CallRecord, 'id' | 'tool' | 'client' | 'via' | 'status' | 'durationMs' | 'createdAt'> & {
  error?: string | null
  kind?: string
}

const READ_LABEL: Record<string, string> = { manual: 'manual', playbook: 'playbook', link: 'link' }

export const CallRow = ({ call, onOpen, fresh }: { call: CallLike; onOpen?: () => void; fresh?: boolean }) => {
  const outcome = OUTCOME[call.status] ?? { tone: 'neutral' as const, label: call.status }
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-border px-4 py-3 text-left text-sm transition-colors hover:bg-muted sm:grid-cols-[5.5rem_minmax(0,1fr)_9rem_7rem_4.5rem]',
          fresh && 'animate-in fade-in-0 slide-in-from-top-1 bg-mist/50 duration-500',
        )}
      >
        <span className="order-3 font-mono text-xs text-muted-foreground sm:order-none">{when(call.createdAt)}</span>
        <span className="flex min-w-0 items-baseline gap-2">
          {call.kind && READ_LABEL[call.kind] ? (
            <span className="shrink-0 text-[11px] tracking-wide text-muted-foreground uppercase">
              {READ_LABEL[call.kind]}
            </span>
          ) : null}
          <span className="min-w-0 truncate font-mono text-[13px]">{call.tool}</span>
        </span>
        <span className="order-4 truncate text-xs text-muted-foreground sm:order-none sm:text-sm">
          {call.client === 'owner' ? 'You' : call.client} · {VIA_LABEL[call.via] ?? call.via}
        </span>
        <Status tone={outcome.tone} className="justify-self-end sm:justify-self-start">
          {outcome.label}
        </Status>
        <span className="hidden text-right font-mono text-xs text-muted-foreground sm:inline">
          {duration(call.durationMs)}
        </span>
      </button>
    </li>
  )
}
