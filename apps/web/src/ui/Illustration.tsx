/**
 * One of the Open Doodles illustrations (CC0, public/illustrations/CREDITS.md), recoloured to the palette and served
 * from /app/illustrations. Decoration,
 * never content: always `alt=""`.
 */
import { cn } from './cn'

export type IllustrationName =
  | 'agents'
  | 'all-clear'
  | 'broken'
  | 'celebrate'
  | 'connect'
  | 'connections'
  | 'explore'
  | 'launch'
  | 'not-found'
  | 'nothing-found'
  | 'sign-in'
  | 'storm'
  | 'tools'
  | 'waiting'

export const Illustration = ({ name, className }: { name: IllustrationName; className?: string }) => (
  <img
    src={`/app/illustrations/${name}.svg`}
    alt=""
    aria-hidden="true"
    loading="lazy"
    decoding="async"
    className={cn('pointer-events-none select-none', className)}
  />
)
