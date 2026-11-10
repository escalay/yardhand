/**
 * The gateway's scheduled jobs: for each, when it last ran and what it did (remembered across restarts), when the
 * next run is due, and a way to run it now.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, type Schemas, unwrap } from '@/api/client'
import { ago, duration } from '@/ui/format'
import { Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import { JOBS, nextLine } from './jobs.rules'
import { SettingsCard } from './SettingsGroup'

type Job = Schemas['JobRun']

const JobRow = ({ job }: { job: Job }) => {
  const queries = useQueryClient()
  const run = useMutation({
    mutationFn: () => unwrap(api.POST('/api/system/jobs/{name}/runs', { params: { path: { name: job.name } } })),
    onSuccess: (system) => {
      queries.setQueryData(['system'], system)
      const last = system.jobs.find((entry) => entry.name === job.name)
      if (last?.ok) toast.success(last.detail ?? 'Done.')
      else toast.error(last?.detail ?? 'It failed: the server log has why.')
    },
    onError: (error) => toast.error(error.message),
  })
  const busy = run.isPending || job.running
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-4 text-sm">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium">{JOBS[job.name].title}</span>
        <span className="text-pretty text-muted-foreground">
          {job.at ? (job.detail ?? JOBS[job.name].does) : JOBS[job.name].does}
        </span>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex flex-col items-end gap-0.5 text-xs">
          {busy ? (
            <Status tone="neutral">running now</Status>
          ) : job.at ? (
            <Status tone={job.ok ? 'ok' : 'error'}>
              {job.ok ? 'ran' : 'failed'} {ago(job.at)}
              {job.ms === null ? '' : `, took ${duration(job.ms)}`}
            </Status>
          ) : (
            <span className="text-muted-foreground">never ran</span>
          )}
          <span className="text-muted-foreground">{nextLine(job.next)}</span>
        </div>
        <Button size="sm" variant="muted" disabled={busy} onClick={() => run.mutate()}>
          {busy ? 'Running…' : 'Run now'}
        </Button>
      </div>
    </div>
  )
}

export const Jobs = ({ jobs }: { jobs: Job[] }) =>
  jobs.length ? (
    <SettingsCard>
      {jobs.map((job) => (
        <JobRow key={job.name} job={job} />
      ))}
    </SettingsCard>
  ) : (
    <SettingsCard>
      <p className="px-5 py-4 text-sm text-muted-foreground">
        This process runs without its scheduler (a demo or a test), so nothing syncs or backs up by itself.
      </p>
    </SettingsCard>
  )
