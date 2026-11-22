/**
 * Build or Refresh a pack with AI: what it is for (edited where the pack is edited), up to five example tasks, then
 * the estimate before anything runs: the likely cost against the cap, how many real read calls the rehearsal may make
 * and where their answers go. Start waits for the estimate; a start the gateway would refuse is held back here, since
 * every start counts toward six an hour.
 */
import { IconPencil, IconPlus, IconSparkles, IconX } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ApiError, api, type Schemas, unwrap } from '@/api/client'
import { BUILDS_CARD_ID } from '@/settings/ai.rules'
import { Field } from '@/ui/Field'
import { Button } from '@/ui/shadcn/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/shadcn/dialog'
import { Input } from '@/ui/shadcn/input'
import { useSettled } from '@/ui/useSettled'
import { estimateLine, MAX_TASKS, overCap, realCallsLine, startProblem, tasksProblem } from './build.rules'
import { buildEstimateQuery } from './queries'

type Pack = Schemas['Pack']
type Mode = Schemas['PackBuildRequest']['mode']

const Problem = ({ error, title }: { error: Error; title: string }) => {
  const said = startProblem(
    error instanceof ApiError
      ? { status: error.status, message: error.message, code: error.code, retryAfter: error.retryAfter }
      : { status: 0, message: error.message },
    title,
  )
  return (
    <p role="alert" className="text-sm text-error">
      {said.text}{' '}
      {said.settings ? (
        <Link
          to="/settings"
          hash={BUILDS_CARD_ID}
          className="rounded-xs text-foreground underline underline-offset-4 hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          Open Settings › AI
        </Link>
      ) : null}
    </p>
  )
}

export const BuildDialog = ({
  pack,
  mode,
  open,
  onOpenChange,
  onEdit,
  onStarted,
}: {
  pack: Pack
  mode: Mode
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Edit what the pack is for: the build drafts from it. */
  onEdit: () => void
  onStarted: (id: string) => void
}) => {
  const queries = useQueryClient()
  const [tasks, setTasks] = useState([''])
  // Opened again, it starts from no tasks, not from what was typed last time
  const [shown, setShown] = useState(open)
  if (open !== shown) {
    setShown(open)
    if (open) setTasks([''])
  }
  const given = tasks.map((task) => task.trim()).filter(Boolean)
  const problem = tasksProblem(tasks)
  // The tasks once typing rests, one a line: a string, so a render that changes nothing doesn't start the wait again
  const settled = useSettled(problem ? '' : given.join('\n'), 400)
  const estimate = useQuery({
    ...buildEstimateQuery(pack.name, { mode, tasks: settled ? settled.split('\n') : [] }),
    enabled: open && Boolean(settled) && !problem,
  })
  const start = useMutation({
    mutationFn: (body: Schemas['PackBuildRequest']) =>
      unwrap(api.POST('/api/packs/{name}/builds', { params: { path: { name: pack.name } }, body })),
    onSuccess: (build) => {
      void queries.invalidateQueries({ queryKey: ['pack', pack.name] })
      onStarted(build.id)
    },
  })
  const figure = estimate.data
  // The figure on screen is for the tasks as typed, not ones since changed
  const current = Boolean(figure) && settled === given.join('\n')
  const tooDear = figure ? overCap(figure) : false
  const running = pack.build?.status === 'running'
  const verb = mode === 'build' ? 'Build' : 'Refresh'
  const setTask = (index: number, value: string) =>
    setTasks((list) => list.map((task, at) => (at === index ? value : task)))
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) start.reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {verb} {pack.title} with AI
          </DialogTitle>
          <DialogDescription>
            {mode === 'build'
              ? 'A model drafts its tools, wording, variables, playbooks and skill from what it is for and a few example tasks, then tries each task. Nothing changes in the pack until you accept lines.'
              : 'A model proposes changes to the pack as it is, from what it is for and a few example tasks, then tries each task. Nothing changes in the pack until you accept lines.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            start.mutate({ mode, tasks: given })
          }}
        >
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">What it is for</span>
              <Button type="button" size="xs" variant="ghost" onClick={onEdit}>
                <IconPencil /> Edit
              </Button>
            </div>
            <p className="border border-border bg-muted/40 px-3 py-2 text-sm whitespace-pre-line text-pretty text-muted-foreground">
              {pack.description || 'No description yet: the build drafts from what the pack is for, so say it first.'}
            </p>
          </div>
          <fieldset className="flex min-w-0 flex-col gap-3">
            <legend className="mb-1.5 text-sm font-medium">Example tasks</legend>
            <p className="-mt-1 text-sm text-muted-foreground">
              What someone would ask an agent with this pack. Each gets a playbook and is tried before you see the
              proposal.
            </p>
            {tasks.map((task, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: a task is its place in the list while it is typed
                key={index}
                className="flex items-end gap-2"
              >
                <Field label={`Task ${index + 1}`} className="min-w-0 flex-1">
                  {(id) => (
                    <Input
                      id={id}
                      value={task}
                      maxLength={300}
                      placeholder={index ? undefined : 'e.g. find a quick dinner recipe'}
                      onChange={(event) => setTask(index, event.target.value)}
                    />
                  )}
                </Field>
                {tasks.length > 1 ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Take task ${index + 1} out`}
                    onClick={() => setTasks((list) => list.filter((_, at) => at !== index))}
                  >
                    <IconX />
                  </Button>
                ) : null}
              </div>
            ))}
            {tasks.length < MAX_TASKS ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="self-start"
                onClick={() => setTasks((list) => [...list, ''])}
              >
                <IconPlus /> Add a task
              </Button>
            ) : null}
            {problem && tasks.some((task) => task.trim()) ? (
              <p role="alert" className="text-sm text-error">
                {problem}
              </p>
            ) : null}
          </fieldset>
          <div
            role="status"
            aria-live="polite"
            className="flex flex-col gap-2 border border-border bg-card p-4 text-sm text-pretty"
          >
            {problem ? (
              <p className="text-muted-foreground">The estimate comes once there is a task.</p>
            ) : estimate.error ? (
              <Problem error={estimate.error} title={pack.title} />
            ) : !current || !figure ? (
              <p className="text-muted-foreground">Working out what it may cost…</p>
            ) : (
              <>
                <p>
                  {estimateLine(figure)}. It tries each task first: {realCallsLine(figure.realCalls)} (those may cost on
                  their own), and what they return is sent to {figure.model}. Tools that change things are never run.
                </p>
                {figure.note ? <p className="text-muted-foreground">{figure.note}</p> : null}
                {tooDear ? (
                  <p role="alert" className="text-error">
                    That is over the ${figure.capUsd.toFixed(2)} a build may spend: give fewer example tasks.
                  </p>
                ) : null}
              </>
            )}
            {mode === 'refresh' ? (
              <p className="text-muted-foreground">
                Refresh also sends the pack as it is: its tools, wording, variables and the values it fills.
              </p>
            ) : null}
          </div>
          {running ? (
            <p className="text-sm text-muted-foreground">A build of {pack.title} is running: wait for its proposal.</p>
          ) : null}
          {start.error ? <Problem error={start.error} title={pack.title} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={Boolean(problem) || !current || tooDear || running || start.isPending}
            >
              <IconSparkles /> {start.isPending ? 'Starting…' : verb}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
