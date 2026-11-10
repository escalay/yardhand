/**
 * The bar under the tabs on every screen that shows numbers: the window, the door, comparing with the window before,
 * the scope (the page passes its picker), then refresh and export on the right; whether events are live is in the
 * top bar. It sticks below the tabs while the page scrolls.
 */
import { IconDownload, IconRefresh } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { DOORS, type Door, RANGES, type Range } from '@/shell/filters.rules'
import { cn } from './cn'
import { Button } from './shadcn/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './shadcn/select'
import { Switch } from './shadcn/switch'

const ANY = '__any'

export const RangePick = ({
  value,
  onChange,
  anyLabel,
}: {
  value: Range | undefined
  onChange: (range: Range | undefined) => void
  /** Offer "no window" with this label (the log's whole 90 days). */
  anyLabel?: string
}) => (
  <Select value={value ?? ANY} onValueChange={(next) => onChange(next === ANY ? undefined : (next as Range))}>
    <SelectTrigger size="sm" aria-label="Window" className="min-w-36 bg-card">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {anyLabel ? <SelectItem value={ANY}>{anyLabel}</SelectItem> : null}
      {RANGES.map((range) => (
        <SelectItem key={range.value} value={range.value}>
          {range.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
)

export const DoorPick = ({
  value,
  onChange,
}: {
  value: Door | undefined
  onChange: (door: Door | undefined) => void
}) => (
  <fieldset className="m-0 hidden border-0 p-0 sm:inline-flex">
    <legend className="sr-only">Door</legend>
    <div className="inline-flex border border-border bg-card">
      {[{ value: undefined, label: 'All doors' }, ...DOORS].map((door) => (
        <button
          key={door.label}
          type="button"
          aria-pressed={value === door.value}
          onClick={() => onChange(door.value as Door | undefined)}
          className={cn(
            'h-8 border-r border-border px-2.5 text-xs text-muted-foreground transition-colors last:border-r-0 hover:text-foreground',
            value === door.value && 'bg-mist text-foreground',
          )}
        >
          {door.label}
        </button>
      ))}
    </div>
  </fieldset>
)

export const CompareSwitch = ({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) => (
  <label className="flex cursor-pointer items-center gap-2 px-1 text-xs text-muted-foreground">
    <Switch checked={checked} onCheckedChange={onChange} aria-label="Compare with the window before" />
    <span className="hidden md:inline">Compare to before</span>
  </label>
)

export const FilterBar = ({
  children,
  exportHref,
  refresh,
}: {
  children: React.ReactNode
  /** A same-origin download of what the bar shows (CSV). */
  exportHref?: string
  /** Query keys to refetch on refresh. */
  refresh?: string[][]
}) => {
  const queries = useQueryClient()
  return (
    <div className="sticky top-14 z-20 lg:top-0 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2 sm:px-8">
        {children}
        <div className="ml-auto flex items-center gap-1">
          {refresh ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh"
              onClick={() => {
                for (const key of refresh) void queries.invalidateQueries({ queryKey: key })
              }}
            >
              <IconRefresh />
            </Button>
          ) : null}
          {exportHref ? (
            <Button asChild variant="ghost" size="icon-sm" aria-label="Export as CSV">
              <a href={exportHref} download>
                <IconDownload />
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
