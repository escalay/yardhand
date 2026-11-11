/**
 * Updates in Settings: the version running and the newest one with its release notes, the two switches, and "Update
 * now" where something can carry it out (the updater container, or the platform's deploy hook); elsewhere the
 * commands to run. A run is followed step by step, through the restart, and the page loads the new app when it ends.
 */
import { IconChevronDown } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api, type Schemas, unwrap } from '@/api/client'
import { updatesQuery } from '@/shell/queries'
import { Code } from '@/ui/Code'
import { ago, when } from '@/ui/format'
import { Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/shadcn/collapsible'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { Switch } from '@/ui/shadcn/switch'
import { SettingsCard, SettingsGroup } from './SettingsGroup'
import { autoBlocked, follows, headlineOf, howLine, OUTCOME, POLL_MS, reloadsAfter, UPDATES_ID } from './updates.rules'

type View = Schemas['Updates']

const TONE = {
  working: 'live',
  done: 'ok',
  failed: 'error',
  refused: 'warn',
  available: 'warn',
  current: 'ok',
} as const
const WORD = {
  working: 'Updating',
  done: 'Updated',
  failed: 'Put back',
  refused: 'Refused',
  available: 'Update available',
  current: 'Up to date',
} as const

const SwitchRow = ({
  title,
  line,
  checked,
  disabled,
  onChange,
}: {
  title: string
  line: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) => (
  <div className="flex items-center justify-between gap-6 px-5 py-4">
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-sm font-medium">{title}</span>
      <span className="text-sm text-pretty text-muted-foreground">{line}</span>
    </div>
    <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={title} />
  </div>
)

const History = ({ runs }: { runs: View['history'] }) => (
  <Collapsible className="px-5 py-3">
    <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 text-left text-sm text-muted-foreground hover:text-foreground">
      Past updates ({runs.length})
      <IconChevronDown className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
    <CollapsibleContent className="pt-3">
      <ul className="flex flex-col gap-2 text-sm">
        {runs.map((run) => (
          <li key={`${run.id}-${run.at}`} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5">
            <span className="font-mono text-[13px]">
              {run.from} → {run.to}
            </span>
            <span className="flex items-baseline gap-3">
              <Status tone={OUTCOME[run.state].tone}>{OUTCOME[run.state].label}</Status>
              <span className="text-muted-foreground" title={run.at}>
                {when(run.at)}
              </span>
            </span>
            {run.detail ? <span className="basis-full text-pretty text-muted-foreground">{run.detail}</span> : null}
          </li>
        ))}
      </ul>
    </CollapsibleContent>
  </Collapsible>
)

type Asked = { before: string | null; at: number } | null

const Card = ({
  view,
  restarting,
  asked,
  onAsked,
}: {
  view: View
  restarting: boolean
  asked: Asked
  onAsked: (asked: Asked) => void
}) => {
  const queries = useQueryClient()
  const keep = (next: View) => queries.setQueryData(updatesQuery.queryKey, next)
  const fail = (error: Error) => toast.error(error.message)
  const check = useMutation({
    mutationFn: () => unwrap(api.POST('/api/system/updates/check')),
    onSuccess: (next) => {
      keep(next)
      toast.success(
        next.newer && next.latest ? `Yardhand ${next.latest.version} is out.` : 'This is the newest version.',
      )
    },
    onError: fail,
  })
  const change = useMutation({
    mutationFn: (body: Schemas['UpdatesChange']) => unwrap(api.PATCH('/api/system/updates', { body })),
    onSuccess: keep,
    onError: fail,
  })
  const update = useMutation({
    mutationFn: () => unwrap(api.POST('/api/system/updates/requests', { body: {} })),
    onSuccess: (next) => {
      keep(next)
      if (next.how === 'hook')
        toast.success('The deploy hook was called. Yardhand restarts when your platform starts the new version.')
      else onAsked({ before: view.status?.id ?? null, at: Date.now() })
    },
    onError: fail,
  })
  const waiting = follows(view.status, asked) && view.status?.state !== 'working'
  const watched = useRef(false)
  if (follows(view.status, asked)) watched.current = true
  useEffect(() => {
    if (!reloadsAfter(watched.current, view.status, asked?.before)) return
    watched.current = false
    toast.success(`Updated to ${view.status?.to}. Loading the new version…`)
    const timer = setTimeout(() => location.reload(), 1500)
    return () => clearTimeout(timer)
  }, [view.status, asked])

  const headline = headlineOf(view)
  const busy = headline.kind === 'working' || waiting
  const offer = view.newer && view.latest && !busy
  const blocked = autoBlocked(view)
  return (
    <SettingsCard>
      <div className="flex items-start justify-between gap-4 px-5 py-4" aria-live="polite">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium">
            {waiting && view.latest ? `Updating to ${view.latest.version}` : headline.title}
          </span>
          <span className="text-sm text-pretty text-muted-foreground">
            {restarting && busy
              ? 'Restarting… Yardhand is coming back on the new version.'
              : waiting
                ? 'Asked. The updater takes it within a few seconds.'
                : headline.line}
            {offer && view.latest ? (
              <>
                {' '}
                <a href={view.latest.notes} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                  Release notes
                </a>
              </>
            ) : null}
          </span>
        </div>
        <Status tone={busy ? 'live' : TONE[headline.kind]}>{busy ? WORD.working : WORD[headline.kind]}</Status>
      </div>
      {offer ? (
        view.how === 'manual' ? (
          <div className="flex flex-col gap-3 px-5 py-4">
            <p className="text-sm text-pretty text-muted-foreground">
              Nothing here can install it for you: no updater container runs beside this instance. In the folder with
              your docker-compose.yml, run these; your .env and data stay as they are.{' '}
              <a href={view.docs} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                docs/updates.md
              </a>{' '}
              covers other installs.
            </p>
            <Code copy label="shell">
              {view.manual}
            </Code>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4">
            <p className="min-w-0 flex-1 basis-72 text-sm text-pretty text-muted-foreground">{howLine(view.how)}</p>
            <Button size="sm" disabled={update.isPending} onClick={() => update.mutate()}>
              {update.isPending ? 'Asking…' : 'Update now'}
            </Button>
          </div>
        )
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-4 text-sm">
        <span className="text-pretty text-muted-foreground">
          {view.latest ? `Last checked ${ago(view.latest.checkedAt)}.` : 'Not checked yet.'} A check is one plain
          request for the newest version number: no id, no report.
        </span>
        <Button size="sm" variant="muted" disabled={check.isPending || busy} onClick={() => check.mutate()}>
          {check.isPending ? 'Checking…' : 'Check now'}
        </Button>
      </div>
      <SwitchRow
        title="Check for updates daily"
        line={
          view.check
            ? 'Once a day. A newer version shows here and on Home.'
            : 'Off: nothing asks for a newer version unless you choose Check now.'
        }
        checked={view.check}
        disabled={change.isPending}
        onChange={(next) => change.mutate({ check: next })}
      />
      <SwitchRow
        title="Update automatically"
        line={
          blocked ??
          (view.auto
            ? 'A newer version is installed by itself after the daily check. One that failed isn’t tried again.'
            : 'Off: a newer version waits until you choose Update now.')
        }
        checked={view.auto}
        disabled={change.isPending || Boolean(blocked)}
        onChange={(next) => change.mutate({ auto: next })}
      />
      {view.history.length ? <History runs={view.history} /> : null}
    </SettingsCard>
  )
}

export const Updates = () => {
  // The run this page asked for, by the run that was there before it: the page follows until the updater answers
  const [asked, setAsked] = useState<Asked>(null)
  // While a run is followed the answer is asked for again every few seconds; a failed one in between is the restart
  const updates = useQuery({
    ...updatesQuery,
    refetchInterval: (query) => (follows(query.state.data?.status ?? null, asked) ? POLL_MS : false),
    retry: false,
  })
  useEffect(() => {
    if (location.hash === `#${UPDATES_ID}`) document.getElementById(UPDATES_ID)?.scrollIntoView()
  }, [])
  return (
    <SettingsGroup
      id={UPDATES_ID}
      title="Updates"
      description="The version running here and the newest one. Yardhand never updates itself: the updater beside it does, after checking the release’s signature and backing up the data."
    >
      {updates.data ? (
        <Card view={updates.data} restarting={Boolean(updates.error)} asked={asked} onAsked={setAsked} />
      ) : updates.isPending ? (
        <Skeleton className="h-40 rounded-none" />
      ) : (
        <SettingsCard>
          <p className="px-5 py-4 text-sm text-muted-foreground">{updates.error?.message}</p>
        </SettingsCard>
      )}
    </SettingsGroup>
  )
}
