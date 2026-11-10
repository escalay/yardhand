/** An empty state that says what goes here and hands over the one action that fills it. */
import { cn } from './cn'
import { Illustration, type IllustrationName } from './Illustration'

export const Empty = ({
  illustration,
  title,
  children,
  action,
  className,
}: {
  illustration: IllustrationName
  title: React.ReactNode
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) => (
  <div
    className={cn(
      'flex flex-col items-center gap-5 border border-border bg-card px-6 py-14 text-center sm:py-20',
      className,
    )}
  >
    <Illustration name={illustration} className="h-36 w-auto sm:h-44" />
    <div className="flex max-w-md flex-col gap-2">
      <h2 className="text-xl tracking-tight text-balance">{title}</h2>
      {children ? <p className="text-sm text-pretty text-muted-foreground">{children}</p> : null}
    </div>
    {action ? <div className="flex flex-wrap justify-center gap-2">{action}</div> : null}
  </div>
)
