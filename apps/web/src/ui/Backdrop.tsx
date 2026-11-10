/**
 * The yard: graphite ground, a signal-blue glow, and tracks fanning in from the edge and running into one, Yardhand's
 * idea drawn as lines. Pure SVG and CSS, still for everyone; it fills its positioned parent.
 */
import { cn } from './cn'

/** Tracks from the left edge, each curving into the one line at the right. */
const TRACKS = Array.from({ length: 9 }, (_, index) => {
  const y = 40 + index * 65
  return `M -20 ${y} C 360 ${y}, 520 300, 900 300 L 1240 300`
})

export const Backdrop = ({ className }: { className?: string }) => (
  <div aria-hidden="true" className={cn('absolute inset-0 overflow-hidden bg-inverse', className)}>
    <div
      className="absolute inset-0"
      style={{
        background:
          'radial-gradient(90% 70% at 85% 45%, oklch(54% 0.19 256 / 0.55), transparent 60%), radial-gradient(60% 50% at 10% 100%, oklch(40% 0.12 256 / 0.5), transparent 70%)',
      }}
    />
    <svg
      aria-hidden="true"
      className="absolute inset-0 size-full"
      viewBox="0 0 1200 600"
      preserveAspectRatio="xMidYMid slice"
      fill="none"
      stroke="currentColor"
    >
      <g className="text-inverse-foreground/15" strokeWidth="1.2">
        {TRACKS.map((path) => (
          <path key={path} d={path} />
        ))}
      </g>
      <path d="M 900 300 L 1240 300" className="text-primary-highlight" strokeWidth="2.5" />
    </svg>
    <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-inverse to-transparent" />
  </div>
)
