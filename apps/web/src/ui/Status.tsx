/** An outcome as text with a dot (the console layer's only colour): ok, warn, error, or plain. */
import { cn } from './cn'

export type Tone = 'ok' | 'warn' | 'error' | 'neutral' | 'live'

const DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  error: 'bg-error',
  neutral: 'bg-faint-foreground',
  live: 'bg-ok animate-pulse-dot',
}
const TEXT: Record<Tone, string> = {
  ok: 'text-foreground',
  warn: 'text-foreground',
  error: 'text-error',
  neutral: 'text-muted-foreground',
  live: 'text-foreground',
}

export const Dot = ({ tone, className }: { tone: Tone; className?: string }) => (
  <span aria-hidden="true" className={cn('inline-block size-1.5 shrink-0 rounded-full', DOT[tone], className)} />
)

export const Status = ({
  tone,
  children,
  className,
}: {
  tone: Tone
  children: React.ReactNode
  className?: string
}) => (
  <span className={cn('inline-flex items-center gap-1.5 text-sm', TEXT[tone], className)}>
    <Dot tone={tone} />
    {children}
  </span>
)

/** How a call ended, in words. */
export const OUTCOME: Record<string, { tone: Tone; label: string }> = {
  ok: { tone: 'ok', label: 'OK' },
  tool_error: { tone: 'warn', label: 'Tool said no' },
  refused: { tone: 'neutral', label: 'Refused' },
  failed: { tone: 'error', label: 'Upstream failed' },
  asked: { tone: 'neutral', label: 'Asked' },
}

/** How an upstream is, in words. */
export const HEALTH: Record<string, { tone: Tone; label: string }> = {
  live: { tone: 'ok', label: 'Live' },
  failing: { tone: 'error', label: 'Not answering' },
  new: { tone: 'neutral', label: 'Not synced yet' },
}
