/** A form field: label, the control, a hint, and the problem when there is one. */
import { useId } from 'react'
import { cn } from './cn'
import { Label } from './shadcn/label'

export const Field = ({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  error?: string | null
  children: (id: string) => React.ReactNode
  className?: string
}) => {
  const id = useId()
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      {children(id)}
      {error ? (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
