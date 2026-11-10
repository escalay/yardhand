/**
 * Calls per hour (or day): signal-blue bars, the failed share in red at the foot of each, an empty day as a faint
 * stub so the week reads as a week. By day, each bar has its day under it.
 */
import type { Overview } from '@/api/client'
import { cn } from '@/ui/cn'
import { plural } from '@/ui/format'
import { barHeights } from './home.rules'

type Bucket = Overview['calls']['hourly'][number]

const labelOf = (bucket: Bucket, by: 'hour' | 'day') =>
  by === 'hour'
    ? `${new Date(`${bucket.at}:00:00Z`).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : new Date(`${bucket.at}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })

export const CallsChart = ({ buckets, by, window }: { buckets: Bucket[]; by: 'hour' | 'day'; window?: string }) => {
  const heights = barHeights(buckets.map((bucket) => bucket.total))
  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0)
  const errors = buckets.reduce((sum, bucket) => sum + bucket.errors, 0)
  const daily = by === 'day'
  return (
    <figure className="flex flex-col gap-2">
      <div
        className={cn('flex h-32 items-end border-b border-border', daily ? 'gap-2 sm:gap-4' : 'gap-[3px]')}
        role="img"
        aria-label={`${plural(total, 'call')} in the ${window ?? (daily ? 'last 7 days' : 'last 24 hours')}, ${plural(errors, 'error')}`}
      >
        {buckets.map((bucket, index) => (
          <div
            key={bucket.at}
            className="group relative flex h-full flex-1 flex-col items-center justify-end"
            title={`${labelOf(bucket, by)}: ${plural(bucket.total, 'call')}${bucket.errors ? `, ${bucket.errors} failed` : ''}`}
          >
            {bucket.total ? (
              <span className="absolute -top-0.5 hidden font-mono text-[10px] text-muted-foreground group-hover:block">
                {bucket.total}
              </span>
            ) : null}
            <div
              className={cn('flex w-full flex-col justify-end', daily && 'max-w-14')}
              style={{ height: `${bucket.total ? heights[index] : 2}%` }}
            >
              <div
                className={cn(
                  'flex-1 transition-colors',
                  bucket.total ? 'bg-primary/85 group-hover:bg-primary' : 'bg-border',
                )}
              />
              {bucket.errors ? (
                <div className="bg-error" style={{ height: `${(bucket.errors / Math.max(bucket.total, 1)) * 100}%` }} />
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {daily ? (
        <figcaption className="flex gap-2 font-mono text-[11px] text-faint-foreground sm:gap-4">
          {buckets.map((bucket, index) => (
            <span key={bucket.at} className="flex-1 truncate text-center">
              {index === buckets.length - 1 ? 'today' : labelOf(bucket, by)}
            </span>
          ))}
        </figcaption>
      ) : (
        <figcaption className="flex justify-between font-mono text-[11px] text-faint-foreground">
          <span>{buckets[0] ? labelOf(buckets[0], by) : ''}</span>
          <span>now</span>
        </figcaption>
      )}
    </figure>
  )
}
