/**
 * Setting a pack up in four steps: describe it, add tools, try it as the pack, connect an app. A step done is ticked;
 * one still to do leads to where it is done. Gone once all four are.
 */
import { IconCheck, IconCircleDashed } from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'
import type { Pack } from '@/api/client'
import { Section } from '@/ui/Page'
import { type ChecklistStep, checklistOf } from './packs.rules'
import { TRY_ID } from './TryIt'

const TODO = 'text-left underline underline-offset-4 hover:text-primary'

const Todo = ({ step, pack, onEdit }: { step: ChecklistStep; pack: Pack; onEdit: () => void }) => {
  switch (step.id) {
    case 'describe':
      return (
        <button type="button" className={TODO} onClick={onEdit}>
          {step.label}
        </button>
      )
    case 'tools':
      return (
        <Link to="/packs/$name" params={{ name: pack.name }} className={TODO}>
          {step.label}
        </Link>
      )
    case 'try':
      return (
        <Link
          to="/packs/$name"
          params={{ name: pack.name }}
          search={{ tab: 'overview' }}
          hash={TRY_ID}
          className={TODO}
        >
          {step.label}
        </Link>
      )
    case 'connect':
      // A key of a pack without tools would reach nothing: the step waits for the tools
      return pack.tools.length ? (
        <Link to="/agents/new" search={{ pack: pack.name }} className={TODO}>
          {step.label}
        </Link>
      ) : (
        <span>{step.label}</span>
      )
  }
}

export const Checklist = ({ pack, onEdit }: { pack: Pack; onEdit: () => void }) => {
  const list = checklistOf(pack)
  if (list.complete) return null
  return (
    <Section
      title={`Set up ${pack.title}`}
      aside={
        <span className="font-mono text-xs text-muted-foreground">
          {list.done} of {list.total}
        </span>
      }
    >
      <ol className="flex flex-col gap-x-6 gap-y-2 border border-border bg-card px-4 py-3 text-sm sm:flex-row sm:flex-wrap">
        {list.steps.map((step) => (
          <li key={step.id} className="flex items-center gap-2">
            {step.done ? (
              <IconCheck aria-hidden="true" className="size-4 shrink-0 text-ok" />
            ) : (
              <IconCircleDashed aria-hidden="true" className="size-4 shrink-0 text-faint-foreground" />
            )}
            <span className="sr-only">{step.done ? 'Done:' : 'To do:'}</span>
            {step.done ? (
              <span className="text-muted-foreground">{step.label}</span>
            ) : (
              <Todo step={step} pack={pack} onEdit={onEdit} />
            )}
          </li>
        ))}
      </ol>
    </Section>
  )
}
