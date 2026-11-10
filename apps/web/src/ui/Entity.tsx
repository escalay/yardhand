/**
 * One thing's page (a connection, a pack, an agent, a tool): a trail back, its name, a line about it, its actions,
 * then its parts as tabs. Every one of them has an Activity tab: its own calls.
 */
import { Link } from '@tanstack/react-router'
import { cn } from './cn'
import { type LineTab, LineTabs, TabCount } from './LineTabs'

export type Crumb = { label: string; to: string }

export const EntityHeader = ({
  crumbs,
  title,
  children,
  actions,
  meta,
}: {
  crumbs: Crumb[]
  title: React.ReactNode
  children?: React.ReactNode
  actions?: React.ReactNode
  /** A row under the line: chips, counts, status. */
  meta?: React.ReactNode
}) => (
  <header className="flex flex-col gap-4 pt-2">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 max-w-3xl flex-col gap-2">
        <span className="flex flex-wrap items-center gap-1 text-xs tracking-wide text-muted-foreground uppercase">
          {'/// '}
          {crumbs.map((crumb, index) => (
            <span key={crumb.to} className="inline-flex items-center gap-1">
              {index ? <span className="text-faint-foreground">/</span> : null}
              <Link to={crumb.to as never} className="hover:text-foreground">
                {crumb.label}
              </Link>
            </span>
          ))}
        </span>
        <h1 className="min-w-0 text-3xl tracking-tight break-words text-balance sm:text-4xl">{title}</h1>
        {children ? <div className="text-sm text-pretty text-muted-foreground">{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
    {meta ? (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">{meta}</div>
    ) : null}
  </header>
)

/** An item's parts as tabs kept in the address (`?tab=`); the first tab is the default and leaves no `tab`. */
export const EntityTabs = ({
  tabs,
  active,
  onPick,
  className,
}: {
  tabs: LineTab[]
  active: string
  onPick: (id: string) => void
  className?: string
}) => (
  <LineTabs
    label="Parts"
    tabs={tabs}
    active={active}
    className={cn('-mx-1 border-b border-border', className)}
    render={(tab, props) => (
      <button key={tab.id} type="button" onClick={() => onPick(tab.id)} {...props}>
        {tab.label}
        <TabCount tab={tab} />
      </button>
    )}
  />
)
