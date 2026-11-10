/** Calls still running whose servers report progress: which tool, for whom, how far, in the server's words. */
import { useRunning } from '@/shell/live'
import { Mono } from '@/ui/Code'

export const Running = () => {
  const running = useRunning()
  if (!running.length) return null
  return (
    <section aria-label="Running now" className="flex flex-col gap-2">
      <h2 className="text-xs tracking-wide text-muted-foreground uppercase">Running now</h2>
      <ul className="border border-border bg-card">
        {running.map((step) => {
          const share = step.total ? Math.min(1, step.progress / step.total) : null
          return (
            <li
              key={`${step.clientId}:${step.tool}`}
              className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0"
            >
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
                <Mono className="min-w-0 truncate">{step.tool}</Mono>
                <span className="text-xs text-muted-foreground">
                  {step.client === 'owner' ? 'You' : step.client} ·{' '}
                  {step.total ? `${step.progress} of ${step.total}` : `step ${step.progress}`}
                  {step.message ? ` · ${step.message}` : ''}
                </span>
              </div>
              <div className="h-1 bg-muted">
                <div
                  className={
                    share === null ? 'h-1 w-1/3 animate-pulse bg-primary/60' : 'h-1 bg-primary transition-[width]'
                  }
                  style={share === null ? undefined : { width: `${Math.round(share * 100)}%` }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
