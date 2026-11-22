/**
 * A build's proposal, in place of the pack's parts: every line it would change (tools with their wording and inputs,
 * variables, playbooks, the skill), each with a box, why, and before and after; ticking a line ticks what it needs,
 * and a line a ticked one needs stays until that one is unticked. Then what was left out, the rehearsal a task with
 * each call it made linked to Activity, each step it skipped and whether it was really tried, and the cost. While it
 * runs, the step it is on; a stopped build says what it didn't do, a failed one why.
 */
import { IconArrowLeft, IconCheck, IconSparkles } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { ApiError, api, type Schemas, unwrap } from '@/api/client'
import { diffLines } from '@/reviews/diff.rules'
import { Lines } from '@/reviews/ReviewsPage'
import { Mono } from '@/ui/Code'
import { cn } from '@/ui/cn'
import { Empty } from '@/ui/Empty'
import { Markdown, withoutFrontmatter } from '@/ui/Markdown'
import { Section } from '@/ui/Page'
import { Status } from '@/ui/Status'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/ui/shadcn/alert-dialog'
import { Button } from '@/ui/shadcn/button'
import { Checkbox } from '@/ui/shadcn/checkbox'
import { Skeleton } from '@/ui/shadcn/skeleton'
import {
  BUILD_CAP_USD,
  costLine,
  findingsByLine,
  groupsOf,
  labelOf,
  preselected,
  rehearsalLine,
  sidesOf,
  skippedLine,
  stoppedLine,
  toggled,
  untriedLine,
} from './build.rules'
import { buildQuery, packQuery } from './queries'

type Pack = Schemas['Pack']
type Build = Schemas['PackBuild']
type Line = Schemas['PackBuildLine']
type Proposed = NonNullable<Build['proposal']>

const CHANGE = { add: 'Add', change: 'Change', remove: 'Remove' } as const

/** "A and B", "A, B and C". */
const listed = (items: string[]) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/** A line's before and after: a diff when both are there, the new text as it reads, or the old one struck. */
const Sides = ({ line }: { line: Line }) => {
  const { before, after, markdown } = sidesOf(line)
  if (before !== null && after !== null) return <Lines lines={diffLines(before, after)} />
  if (after !== null)
    return markdown ? (
      <details className="border border-border bg-card">
        <summary className="cursor-pointer px-3 py-2 text-xs tracking-wide text-muted-foreground uppercase select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none">
          Read it
        </summary>
        <Markdown className="border-t border-border px-4 py-3">{withoutFrontmatter(after)}</Markdown>
      </details>
    ) : (
      <p className="font-mono text-[12.5px] break-words">{after}</p>
    )
  return before !== null ? (
    <p className="font-mono text-[12.5px] break-words text-muted-foreground line-through decoration-error/40">
      {before}
    </p>
  ) : null
}

const LineRow = ({
  line,
  lines,
  ticked,
  heldFor,
  refused,
  found,
  onToggle,
}: {
  line: Line
  lines: Line[]
  ticked: boolean
  heldFor: string[]
  refused: string[]
  found: string[]
  onToggle: () => void
}) => {
  const label = labelOf(line)
  const needs = line.needs.map((id) => lines.find((entry) => entry.id === id)).filter((entry) => entry !== undefined)
  return (
    <li
      aria-label={label}
      className={cn(
        'flex flex-col gap-2 border-b border-border px-4 py-4 last:border-b-0 sm:px-5',
        refused.length && 'bg-error/5',
      )}
    >
      <div className="flex items-start gap-3">
        <Checkbox className="mt-0.5" checked={ticked} onCheckedChange={onToggle} aria-label={label} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
            <span className="text-xs tracking-wide text-primary uppercase">{CHANGE[line.change]}</span>
            <span className="font-medium break-all">
              {line.kind === 'skill' ? 'The skill' : <Mono className="text-[13px]">{line.target}</Mono>}
            </span>
            {line.kind === 'wording' ? <span className="text-xs text-muted-foreground">wording</span> : null}
            {line.kind === 'input' ? <span className="text-xs text-muted-foreground">input</span> : null}
            {line.changesThings ? <span className="text-xs text-warn">(changes things)</span> : null}
          </span>
          {line.reason ? <p className="text-sm text-pretty text-muted-foreground">{line.reason}</p> : null}
          {needs.length ? (
            <p className="text-xs text-muted-foreground">Needs {listed(needs.map((entry) => labelOf(entry)))}</p>
          ) : null}
        </div>
      </div>
      <div className="min-w-0 sm:pl-7">
        <Sides line={line} />
      </div>
      {heldFor.length ? (
        <p role="status" className="text-sm sm:pl-7">
          {listed(heldFor)} {heldFor.length === 1 ? 'needs' : 'need'} this: untick{' '}
          {heldFor.length === 1 ? 'it' : 'them'} first.
        </p>
      ) : null}
      {[...refused, ...found].map((message) => (
        <p key={message} className={cn('text-sm sm:pl-7', refused.includes(message) ? 'text-error' : 'text-warn')}>
          {message}
        </p>
      ))}
    </li>
  )
}

const Rehearsal = ({ rehearsal }: { rehearsal: Proposed['rehearsal'] }) => (
  <Section title={`Rehearsal · ${rehearsal.length} ${rehearsal.length === 1 ? 'task' : 'tasks'}`}>
    {rehearsal.length ? (
      <ul className="border border-border bg-card">
        {rehearsal.map((task) => {
          const untried = untriedLine(task)
          return (
            <li
              key={task.task}
              className="flex flex-col gap-2 border-b border-border px-4 py-4 last:border-b-0 sm:px-5"
            >
              <p className="text-sm font-medium text-pretty">{rehearsalLine(task)}</p>
              {untried ? (
                <Status tone="warn" className="items-baseline text-pretty">
                  {untried}
                </Status>
              ) : null}
              {task.steps.length ? (
                <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                  {task.steps.map((step, index) => (
                    <li
                      // biome-ignore lint/suspicious/noArrayIndexKey: a step is its place in the rehearsal
                      key={index}
                      className="break-words"
                    >
                      {!step.ran ? (
                        skippedLine(step)
                      ) : step.callId ? (
                        <>
                          <Link
                            to="/activity"
                            search={{ outcome: 'all', via: 'rehearsal', call: step.callId }}
                            className="rounded-xs text-foreground underline underline-offset-4 hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/40"
                          >
                            {step.tool} ran
                          </Link>
                          {step.error ? `: it failed, ${step.error}` : null}
                        </>
                      ) : (
                        `${step.tool} was refused: ${step.error ?? 'no reason given'}`
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          )
        })}
      </ul>
    ) : (
      <p className="border border-border bg-card px-4 py-4 text-sm text-muted-foreground">
        Nothing was tried: the build stopped before its rehearsal.
      </p>
    )}
  </Section>
)

const Settled = ({ pack, build, onClose }: { pack: Pack; build: Build; onClose: () => void }) => (
  <Empty
    illustration="not-found"
    title={build.status === 'accepted' ? 'This proposal was accepted' : 'This proposal was discarded'}
    action={
      <Button variant="muted" onClick={onClose}>
        <IconArrowLeft /> Back to {pack.title}
      </Button>
    }
  >
    {build.status === 'accepted'
      ? `Its lines are in ${pack.title}. Refresh with AI for a new proposal.`
      : `${pack.title} stayed as it was. Build again for a new proposal.`}
  </Empty>
)

const Ready = ({ pack, build, onClose }: { pack: Pack; build: Build; onClose: () => void }) => {
  const queries = useQueryClient()
  const proposal = build.proposal as Proposed
  const lines = proposal.lines
  const [chosen, setChosen] = useState(() => preselected(lines))
  const [held, setHeld] = useState<{ id: string; heldFor: string[] } | null>(null)
  const accept = useMutation({
    mutationFn: (ids: string[]) =>
      unwrap(
        api.POST('/api/packs/{name}/builds/{id}/accept', {
          params: { path: { name: pack.name, id: build.id } },
          body: { lines: ids },
        }),
      ),
    onSuccess: (data, ids) => {
      queries.setQueryData(packQuery(pack.name).queryKey, data)
      // Its playbooks' and skill's texts, its tries and this build are read again as they are now
      void queries.invalidateQueries({ queryKey: ['pack', pack.name] })
      void queries.invalidateQueries({ queryKey: ['packs'] })
      toast.success(`Accepted ${ids.length} ${ids.length === 1 ? 'line' : 'lines'} into ${pack.title}.`)
      onClose()
    },
  })
  const discard = useMutation({
    mutationFn: () =>
      unwrap(api.DELETE('/api/packs/{name}/builds/{id}', { params: { path: { name: pack.name, id: build.id } } })),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['pack', pack.name] })
      onClose()
    },
  })
  const refused = accept.error instanceof ApiError ? findingsByLine(accept.error.errors) : findingsByLine([])
  const found = findingsByLine(proposal.findings)
  const inOrder = (ids: string[]) => lines.filter((line) => ids.includes(line.id)).map((line) => line.id)
  const stopped = stoppedLine(build, BUILD_CAP_USD)
  const busy = accept.isPending || discard.isPending
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4 border-b border-border pb-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <button
              type="button"
              onClick={onClose}
              className="flex items-center gap-1 self-start rounded-xs text-xs tracking-wide text-muted-foreground uppercase hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
            >
              <IconArrowLeft className="size-3.5" /> {pack.title}’s parts, for now
            </button>
            <h2 className="text-2xl tracking-tight text-balance">Proposal for {pack.title}</h2>
            <p className="text-sm text-pretty text-muted-foreground">
              Drafted by <Mono className="text-xs">{proposal.model}</Mono> from {build.tasks.length} example{' '}
              {build.tasks.length === 1 ? 'task' : 'tasks'}. Nothing changes in {pack.title} until you accept lines.{' '}
              {proposal.includeChanges
                ? 'Accept all takes the lines ticked to begin with, tools that change things among them, as you asked.'
                : 'Accept all takes the lines ticked to begin with; a tool that changes things is yours to tick.'}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" disabled={busy}>
                  Discard
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Discard this proposal?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {pack.title} stays as it is. What the build spent ({costLine(build.spent, BUILD_CAP_USD)}) is not
                    given back.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction onClick={() => discard.mutate()}>Discard</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button variant="muted" disabled={busy || !chosen.length} onClick={() => accept.mutate(inOrder(chosen))}>
              Accept selected ({chosen.length})
            </Button>
            <Button
              variant="primary"
              disabled={busy || !preselected(lines).length}
              onClick={() => accept.mutate(preselected(lines))}
            >
              <IconCheck /> Accept all
            </Button>
          </div>
        </div>
        {stopped ? <p className="border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-pretty">{stopped}</p> : null}
        {accept.error ? (
          <div role="alert" className="flex flex-col gap-1 text-sm text-error">
            <p>{accept.error.message}</p>
            {refused.elsewhere.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        ) : null}
        {discard.error ? (
          <p role="alert" className="text-sm text-error">
            {discard.error.message}
          </p>
        ) : null}
      </header>

      {lines.length ? (
        groupsOf(lines).map((group) => (
          <Section key={group.id} title={`${group.title} · ${group.lines.length}`}>
            <ul className="border border-border bg-card">
              {group.lines.map((line) => (
                <LineRow
                  key={line.id}
                  line={line}
                  lines={lines}
                  ticked={chosen.includes(line.id)}
                  heldFor={held?.id === line.id ? held.heldFor : []}
                  refused={refused.byLine.get(line.id) ?? []}
                  found={found.byLine.get(line.id) ?? []}
                  onToggle={() => {
                    const next = toggled(line.id, chosen, lines)
                    setChosen(next.chosen)
                    setHeld(next.heldFor.length ? { id: line.id, heldFor: next.heldFor } : null)
                    accept.reset()
                  }}
                />
              ))}
            </ul>
          </Section>
        ))
      ) : (
        <p className="border border-border bg-card px-4 py-4 text-sm text-muted-foreground">
          The build proposes no change to {pack.title}: it covers the tasks as it is.
        </p>
      )}

      {proposal.skipped.length ? (
        <Section title={`Left out · ${proposal.skipped.length}`}>
          <ul className="border border-border bg-card">
            {proposal.skipped.map((tool) => (
              <li
                key={tool.name}
                className="flex flex-col gap-0.5 border-b border-border px-4 py-3 text-sm last:border-b-0 sm:px-5"
              >
                <Mono className="text-[13px] break-all">{tool.name}</Mono>
                <span className="text-muted-foreground">{tool.reason}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Rehearsal rehearsal={proposal.rehearsal} />

      <Section title="Cost">
        <div className="flex flex-col gap-1 border border-border bg-card px-4 py-4 text-sm sm:px-5">
          <p className="text-lg tracking-tight">{costLine(build.spent, BUILD_CAP_USD)}</p>
          <p className="text-muted-foreground">
            {build.spent.modelCalls} {build.spent.modelCalls === 1 ? 'ask' : 'asks'} to the model,{' '}
            {build.spent.tokens.toLocaleString('en-US')} tokens.
            {build.costNote ? ` ${build.costNote}` : ''}
          </p>
        </div>
      </Section>
    </div>
  )
}

export const Proposal = ({
  pack,
  id,
  onClose,
  onBuildAgain,
}: {
  pack: Pack
  id: string
  /** Back to the pack's parts. */
  onClose: () => void
  onBuildAgain: () => void
}) => {
  const build = useQuery(buildQuery(pack.name, id))
  const back = (
    <Button variant="muted" onClick={onClose}>
      <IconArrowLeft /> Back to {pack.title}
    </Button>
  )
  if (build.isPending) return <Skeleton className="h-96 rounded-none" />
  if (build.error)
    return (
      <Empty illustration="not-found" title="No such proposal" action={back}>
        {build.error.message}
      </Empty>
    )
  const data = build.data
  if (data.status === 'running')
    return (
      <div className="flex flex-col gap-4 border border-border bg-card p-5 sm:p-6">
        <h2 className="text-2xl tracking-tight text-balance">
          {data.mode === 'build' ? 'Building' : 'Refreshing'} {pack.title} with AI
        </h2>
        <Status tone="live">{data.step ?? 'Starting'}</Status>
        <p className="text-sm text-pretty text-muted-foreground">
          {costLine(data.spent, BUILD_CAP_USD)} so far. It keeps running if you leave: the pack page says when its
          proposal is ready.
        </p>
        <div>{back}</div>
      </div>
    )
  if (data.status === 'failed')
    return (
      <Empty
        illustration="not-found"
        title="The build failed"
        action={
          <>
            <Button variant="primary" onClick={onBuildAgain}>
              <IconSparkles /> Build again
            </Button>
            {back}
          </>
        }
      >
        {data.error ?? 'It stopped without saying why.'}
      </Empty>
    )
  if (data.status === 'accepted' || data.status === 'discarded' || !data.proposal)
    return <Settled pack={pack} build={data} onClose={onClose} />
  return <Ready pack={pack} build={data} onClose={onClose} />
}
