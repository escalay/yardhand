/** A page's head: a small label, a regular-weight heading with one italic word, a line under it, and its actions. */
import { cn } from './cn'

export const Page = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn('mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-8 px-4 py-8 sm:px-8 lg:py-12', className)}>
    {children}
  </div>
)

export const PageHeader = ({
  label,
  title,
  children,
  actions,
}: {
  label: string
  title: React.ReactNode
  children?: React.ReactNode
  actions?: React.ReactNode
}) => (
  <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
    <div className="flex max-w-2xl flex-col gap-2">
      <span className="text-xs tracking-wide text-muted-foreground uppercase">
        {'/// '}
        {label}
      </span>
      <h1 className="text-3xl tracking-tight text-balance sm:text-4xl">{title}</h1>
      {children ? <p className="text-sm text-pretty text-muted-foreground">{children}</p> : null}
    </div>
    {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
  </header>
)

/** A titled block of a page: label in small caps over a hairline. */
export const Section = ({
  title,
  aside,
  children,
  className,
}: {
  title: React.ReactNode
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
}) => (
  <section className={cn('flex min-w-0 flex-col gap-3', className)}>
    <div className="flex items-baseline justify-between gap-4">
      <h2 className="text-xs tracking-wide text-muted-foreground uppercase">{title}</h2>
      {aside ? <div className="text-sm">{aside}</div> : null}
    </div>
    {children}
  </section>
)
