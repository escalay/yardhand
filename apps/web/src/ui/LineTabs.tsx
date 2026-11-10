/** Tabs as an underlined row that scrolls sideways when narrow: the frame's places, sub-sections, an item's parts. */
import { cn } from './cn'

export type LineTab = { id: string; label: React.ReactNode; count?: number | null; dot?: boolean }

export const LineTabs = ({
  tabs,
  active,
  label,
  render,
  className,
}: {
  tabs: LineTab[]
  active: string
  label: string
  /** Each tab as its own element (a router Link or a button), given its classes and whether it is current. */
  render: (tab: LineTab, props: { className: string; 'aria-current'?: 'page' }) => React.ReactNode
  className?: string
}) => (
  <nav
    aria-label={label}
    className={cn(
      'flex h-11 items-stretch gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
      className,
    )}
  >
    {tabs.map((tab) =>
      render(tab, {
        className: cn(
          'relative flex shrink-0 items-center gap-1.5 px-3 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground',
          tab.id === active &&
            'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-foreground',
        ),
        ...(tab.id === active ? { 'aria-current': 'page' as const } : {}),
      }),
    )}
  </nav>
)

/** What a tab shows after its label: a count, or a warn dot with its number. */
export const TabCount = ({ tab }: { tab: LineTab }) =>
  tab.dot && tab.count ? (
    <span className="inline-flex items-center gap-1 font-mono text-[11px] text-foreground">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-warn" />
      {tab.count}
    </span>
  ) : tab.count ? (
    <span className="font-mono text-[11px] text-faint-foreground">{tab.count}</span>
  ) : null
