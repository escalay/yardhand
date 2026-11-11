/** One group of Settings: its title and what it is for on the left, its card on the right, on the page's two lines. */
import type { ReactNode } from 'react'

export const SettingsGroup = ({
  id,
  title,
  description,
  children,
}: {
  id?: string
  title: string
  description: ReactNode
  children: ReactNode
}) => (
  <section
    id={id}
    className="grid min-w-0 scroll-mt-8 grid-cols-1 gap-4 border-t border-border pt-8 first:border-t-0 first:pt-0 lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-12"
  >
    <div className="flex flex-col gap-1.5">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="text-sm text-pretty text-muted-foreground">{description}</p>
    </div>
    <div className="flex min-w-0 flex-col gap-4">{children}</div>
  </section>
)

/** The card a group holds: rows divided by hairlines. */
export const SettingsCard = ({ children }: { children: ReactNode }) => (
  <div className="divide-y divide-border overflow-hidden border border-border bg-card">{children}</div>
)

/** Cells in columns inside a card, each with hairlines right and below; a short last row leaves no stray lines. */
export const SettingsCells = ({ children, className }: { children: ReactNode; className: string }) => (
  <div className="overflow-hidden border border-border bg-card">
    <div className={`-mr-px -mb-px grid [&>*]:border-r [&>*]:border-b [&>*]:border-border ${className}`}>
      {children}
    </div>
  </div>
)
