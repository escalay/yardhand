/**
 * Getting started, compact: how far along, the one next step with its action, and the steps behind it as small
 * marks. The guided setup is one click away for the whole walk-through.
 */
import { IconArrowRight, IconCheck } from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'
import type { Overview } from '@/api/client'
import { cn } from '@/ui/cn'
import { Illustration } from '@/ui/Illustration'
import { Button } from '@/ui/shadcn/button'
import { routeOf, STEP_COPY } from './home.rules'

export const Checklist = ({ setup }: { setup: Overview['setup'] }) => {
  const next = setup.steps.find((step) => step.id === setup.next)
  const copy = next ? STEP_COPY[next.id] : undefined
  return (
    <div className="grid grid-cols-1 border border-border bg-card md:grid-cols-[minmax(0,1fr)_14rem]">
      <div className="flex flex-col gap-5 p-5 sm:p-6">
        <div className="flex items-center gap-4">
          <span className="text-xs tracking-wide text-muted-foreground uppercase">Getting started</span>
          <span className="text-sm text-muted-foreground">
            {setup.done} of {setup.total} done
          </span>
          <div
            className="h-1 flex-1 bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={setup.total}
            aria-valuenow={setup.done}
          >
            <div
              className="h-full bg-primary transition-[width] duration-500"
              style={{ width: `${(setup.done / setup.total) * 100}%` }}
            />
          </div>
        </div>
        {next && copy ? (
          <div className="flex flex-col gap-2">
            <h2 className="text-xl tracking-tight text-balance">{next.title}</h2>
            <p className="max-w-xl text-sm text-pretty text-muted-foreground">{copy.body}</p>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Button asChild variant="primary">
                <Link to={routeOf(next.href) as never}>{copy.action}</Link>
              </Button>
              <Link
                to="/setup"
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                Guided setup <IconArrowRight className="size-3.5" />
              </Link>
            </div>
          </div>
        ) : null}
        <ol className="flex flex-wrap gap-x-4 gap-y-2" aria-label="Steps">
          {setup.steps.map((step, index) => (
            <li
              key={step.id}
              className={cn(
                'flex items-center gap-1.5 text-xs',
                step.done
                  ? 'text-muted-foreground'
                  : step.id === setup.next
                    ? 'text-foreground'
                    : 'text-faint-foreground',
              )}
            >
              <span
                className={cn(
                  'grid size-4 place-items-center rounded-full border text-[10px]',
                  step.done ? 'border-primary bg-primary text-primary-foreground' : 'border-current',
                )}
              >
                {step.done ? <IconCheck className="size-2.5" /> : index + 1}
              </span>
              {step.title}
              <span className="sr-only">{step.done ? ' (done)' : ''}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="hidden items-center justify-center border-l border-border bg-mist/40 p-4 md:flex">
        <Illustration name={setup.done === 0 ? 'connect' : 'launch'} className="h-36 w-auto" />
      </div>
    </div>
  )
}
