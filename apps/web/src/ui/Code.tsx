/** Code, paths and JSON in the mono face, with a copy button when it is meant to be pasted somewhere. */

import { CopyButton } from './Copy'
import { cn } from './cn'

export const Code = ({
  children,
  copy,
  className,
  label,
}: {
  children: string
  copy?: boolean
  className?: string
  label?: string
}) => (
  <div className={cn('group relative border border-border bg-muted', className)}>
    {label || copy ? (
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{label}</span>
        {copy ? <CopyButton text={children} size="xs" variant="ghost" /> : null}
      </div>
    ) : null}
    <pre className="max-h-[32rem] overflow-auto p-3 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground">
      {children}
    </pre>
  </div>
)

/** A name or path inline, in the mono face. */
export const Mono = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <span className={cn('font-mono text-[0.92em]', className)}>{children}</span>
)
