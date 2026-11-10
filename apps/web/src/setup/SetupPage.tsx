/**
 * The guided setup: a page of its own, no tabs, one thing at a time. A rail on the left shows the four steps and where
 * you are; each step says what it is for, does it, and moves on. Leaving at any point is fine: Overview's checklist
 * picks up where you stopped.
 */
import { IconArrowRight, IconCheck, IconPlugConnected, IconSparkles } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { SURFACE_FOR, type SurfaceId } from '@/agents/agents.rules'
import { FirstCall } from '@/agents/FirstCall'
import { Setup } from '@/agents/Setup'
import { api, unwrap } from '@/api/client'
import { upstreamsQuery } from '@/connections/queries'
import { overviewQuery, systemQuery } from '@/shell/queries'
import { Backdrop } from '@/ui/Backdrop'
import { cn } from '@/ui/cn'
import { Field } from '@/ui/Field'
import { plural } from '@/ui/format'
import { Illustration, type IllustrationName } from '@/ui/Illustration'
import { Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'
import { RadioGroup, RadioGroupItem } from '@/ui/shadcn/radio-group'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { agentNameOf, checksOf, doneOf, firstOpen, STEPS, type StepId } from './setup.rules'
import { Wordmark } from './Wordmark'

const VISITED = 'yardhand.setup.visited'
const remembered = (): StepId[] => {
  try {
    return JSON.parse(localStorage.getItem(VISITED) ?? '[]') as StepId[]
  } catch {
    return []
  }
}
const remember = (step: StepId) => {
  try {
    localStorage.setItem(VISITED, JSON.stringify([...new Set([...remembered(), step])]))
  } catch {}
}

const ART: Record<StepId, IllustrationName> = {
  instance: 'launch',
  server: 'connect',
  agent: 'agents',
  done: 'celebrate',
}

const Heading = ({ step, title, children }: { step: StepId; title: React.ReactNode; children: React.ReactNode }) => {
  const index = STEPS.findIndex((entry) => entry.id === step)
  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex max-w-xl flex-col gap-2">
        <span className="text-xs tracking-wide text-muted-foreground uppercase">
          Step {index + 1} of {STEPS.length}
        </span>
        <h1 className="text-3xl tracking-tight text-balance sm:text-4xl">{title}</h1>
        <p className="text-pretty text-muted-foreground">{children}</p>
      </div>
      <Illustration name={ART[step]} className="h-28 w-auto shrink-0 self-start sm:h-36 sm:self-end" />
    </div>
  )
}

const Next = ({
  to,
  children,
  disabled,
  onClick,
}: {
  to: StepId
  children: React.ReactNode
  disabled?: boolean
  onClick?: () => void
}) => (
  <Button asChild={!disabled} variant="primary" disabled={disabled} className="whitespace-nowrap">
    {disabled ? (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        {children} <IconArrowRight />
      </span>
    ) : (
      <Link to="/setup" search={{ step: to }} onClick={onClick}>
        {children} <IconArrowRight />
      </Link>
    )}
  </Button>
)

const Instance = () => {
  const system = useQuery(systemQuery)
  if (!system.data) return <Skeleton className="h-64 rounded-none" />
  const checks = checksOf(system.data, window.location.origin)
  return (
    <>
      <Heading
        step="instance"
        title={
          <>
            Yardhand is <em>running</em>
          </>
        }
      >
        Before agents rely on it, four things worth knowing about this instance. Each one that needs you says what to
        change.
      </Heading>
      <ul className="flex flex-col border border-border bg-card">
        {checks.map((check) => (
          <li key={check.id} className="flex gap-4 border-b border-border px-5 py-4 last:border-b-0">
            <span
              className={cn(
                'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs',
                check.tone === 'ok' ? 'bg-primary text-primary-foreground' : 'bg-warn/20 text-foreground',
              )}
              aria-hidden="true"
            >
              {check.tone === 'ok' ? <IconCheck className="size-3.5" /> : '!'}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-medium">{check.title}</span>
              <span className="text-sm text-pretty break-words text-muted-foreground">{check.body}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Next to="server" onClick={() => remember('instance')}>
          Connect a server
        </Next>
      </div>
    </>
  )
}

const Server = () => {
  const queries = useQueryClient()
  const upstreams = useQuery(upstreamsQuery)
  const sample = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/upstreams', {
          body: {
            id: 'sample',
            kind: 'sample',
            title: 'Sample tools',
            auth: { type: 'none' },
            trust: 'trusted',
            enabled: true,
            linkProxy: false,
          },
        }),
      ),
    onSuccess: () => {
      for (const key of [['upstreams'], ['overview'], ['tools']]) void queries.invalidateQueries({ queryKey: key })
      toast.success('Three sample tools are connected.')
    },
    onError: (error) => toast.error(error.message),
  })
  const rows = upstreams.data?._embedded.upstreams ?? []
  const hasSample = rows.some((row) => row.id === 'sample')
  return (
    <>
      <Heading
        step="server"
        title={
          <>
            Connect your first <em>server</em>
          </>
        }
      >
        A server is anything with tools: an MCP server or a REST API. You connect it once here, and every agent you
        allow can use it.
      </Heading>
      <div className="grid border-t border-l border-border bg-card sm:grid-cols-2">
        <div className="flex flex-col gap-4 border-r border-b border-border p-6">
          <IconPlugConnected className="size-5 text-primary" />
          <div className="flex flex-col gap-1">
            <span className="font-medium">A server of your own</span>
            <span className="text-sm text-pretty text-muted-foreground">
              Paste its address. Yardhand works out what it is and how it signs in, and shows its tools before you add
              it.
            </span>
          </div>
          <Button asChild variant="primary" className="mt-auto self-start">
            <Link to="/connections/new" search={{ from: 'setup' }}>
              Paste an address
            </Link>
          </Button>
        </div>
        <div className="flex flex-col gap-4 border-r border-b border-border p-6">
          <IconSparkles className="size-5 text-primary" />
          <div className="flex flex-col gap-1">
            <span className="font-medium">The sample tools</span>
            <span className="text-sm text-pretty text-muted-foreground">
              No server yet? Start with three harmless tools built in: say it back, the time and dice. Remove them
              whenever you like.
            </span>
          </div>
          <Button
            variant="muted"
            className="mt-auto self-start"
            disabled={hasSample || sample.isPending}
            onClick={() => sample.mutate()}
          >
            {hasSample ? 'Connected' : sample.isPending ? 'Connecting…' : 'Use the sample tools'}
          </Button>
        </div>
      </div>
      {rows.length ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs tracking-wide text-muted-foreground uppercase">Connected</span>
          <ul className="flex flex-col border border-border bg-card">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 border-b border-border px-5 py-3 text-sm last:border-b-0"
              >
                <span className="font-medium">{row.title}</span>
                <Status tone={row.status === 'live' ? 'ok' : row.status === 'failing' ? 'error' : 'neutral'}>
                  {plural(row.toolCount, 'tool')}
                </Status>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex justify-between gap-2">
        <Button asChild variant="ghost">
          <Link to="/setup" search={{ step: 'instance' }}>
            Back
          </Link>
        </Button>
        <Next to="agent" disabled={!rows.length}>
          Connect an agent
        </Next>
      </div>
    </>
  )
}

const CHOICES = (Object.keys(SURFACE_FOR) as SurfaceId[]).filter((id) => id !== 'typescript' && id !== 'claude-ai')

const Agent = () => {
  const queries = useQueryClient()
  const [surface, setSurface] = useState<SurfaceId>('claude-code')
  const [name, setName] = useState(agentNameOf(SURFACE_FOR['claude-code']))
  const [named, setNamed] = useState(false)
  const make = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/clients', { body: { name: name.trim(), scope: 'write', upstreams: 'all' } })),
    onSuccess: () => {
      for (const key of [['clients'], ['overview']]) void queries.invalidateQueries({ queryKey: key })
    },
    onError: (error) => toast.error(error.message),
  })
  const made = make.data
  return (
    <>
      <Heading
        step="agent"
        title={
          <>
            Connect an <em>agent</em>
          </>
        }
      >
        Each agent gets a key of its own, so its calls are its own and you can take its access away without touching the
        others.
      </Heading>
      {made ? (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <span className="text-sm font-medium">Paste this where {SURFACE_FOR[surface]} runs</span>
            <Setup id={made.id} apiKey={made.key} first={surface} />
            <p className="text-xs text-muted-foreground">
              The key is in it now. You won’t see it again after this page.
            </p>
          </div>
          <FirstCall clientId={made.id} name={made.name} since={null} />
        </div>
      ) : (
        <div className="flex flex-col gap-5 border border-border bg-card p-6">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Where does it run?</span>
            <RadioGroup
              value={surface}
              aria-label="Where it runs"
              className="flex flex-wrap gap-2"
              onValueChange={(value) => {
                const id = value as SurfaceId
                setSurface(id)
                if (!named) setName(agentNameOf(SURFACE_FOR[id]))
              }}
            >
              {CHOICES.map((id) => (
                <label
                  key={id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-mist has-[[data-state=checked]]:text-foreground"
                >
                  <RadioGroupItem value={id} />
                  {SURFACE_FOR[id]}
                </label>
              ))}
            </RadioGroup>
          </div>
          <Field label="Name" hint="How it shows in Activity and on its page.">
            {(id) => (
              <Input
                id={id}
                value={name}
                maxLength={80}
                onChange={(event) => {
                  setNamed(true)
                  setName(event.target.value)
                }}
              />
            )}
          </Field>
          <Button
            variant="primary"
            className="self-start"
            disabled={!name.trim() || make.isPending}
            onClick={() => make.mutate()}
          >
            {make.isPending ? 'Making its key…' : 'Make its key'}
          </Button>
          <p className="text-xs text-pretty text-muted-foreground">
            Using claude.ai? It signs in with OAuth instead of a key: Agents › Give access shows its address.
          </p>
        </div>
      )}
      <div className="flex justify-between gap-2">
        <Button asChild variant="ghost">
          <Link to="/setup" search={{ step: 'server' }}>
            Back
          </Link>
        </Button>
        <Button asChild variant={made ? 'primary' : 'ghost'}>
          <Link to="/setup" search={{ step: 'done' }}>
            {made ? 'Finish' : 'Skip for now'} <IconArrowRight />
          </Link>
        </Button>
      </div>
    </>
  )
}

const NEXT = [
  {
    title: 'Try a tool yourself',
    body: 'Run any tool from the browser and see what an agent gets back.',
    to: '/tools',
  },
  {
    title: 'Pin what agents use most',
    body: 'Pinned tools are listed to agents directly, the rest are found by search.',
    to: '/tools',
  },
  {
    title: 'Group tools with AI',
    body: 'Let a model sort each server’s tools into groups you switch together.',
    to: '/settings',
  },
] as const

const Done = () => {
  const overview = useQuery(overviewQuery)
  const totals = overview.data?.totals
  return (
    <>
      <Heading
        step="done"
        title={
          <>
            You’re <em>set up</em>
          </>
        }
      >
        {totals
          ? `${plural(totals.upstreams, 'server')} with ${plural(totals.tools, 'tool')} behind one address. Here is what people usually do next.`
          : 'Here is what people usually do next.'}
      </Heading>
      <div className="grid border-t border-l border-border bg-card sm:grid-cols-3">
        {NEXT.map((item) => (
          <Link
            key={item.title}
            to={item.to}
            className="group flex flex-col gap-2 border-r border-b border-border p-5 transition-colors hover:bg-mist/60"
          >
            <span className="text-sm font-medium">{item.title}</span>
            <span className="text-sm text-pretty text-muted-foreground">{item.body}</span>
            <IconArrowRight className="mt-auto size-4 text-primary transition-transform group-hover:translate-x-0.5" />
          </Link>
        ))}
      </div>
      <div className="flex justify-end">
        <Button asChild variant="primary">
          <Link to="/">
            Go to the overview <IconArrowRight />
          </Link>
        </Button>
      </div>
    </>
  )
}

export const SetupPage = ({ step: asked }: { step?: StepId }) => {
  const overview = useQuery(overviewQuery)
  const navigate = useNavigate()
  const done = overview.data ? doneOf(overview.data.setup, remembered()) : null
  const step = asked ?? (done ? firstOpen(done) : 'instance')
  useEffect(() => {
    if (!asked && done) void navigate({ to: '/setup', search: { step }, replace: true })
  }, [asked, done, step, navigate])
  const index = STEPS.findIndex((entry) => entry.id === step)
  return (
    <div className="grid min-h-svh grid-cols-1 bg-background lg:grid-cols-[20rem_minmax(0,1fr)]">
      <aside className="relative overflow-hidden bg-inverse text-inverse-foreground">
        <Backdrop />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-b from-transparent via-inverse/70 to-inverse"
        />
        <div className="relative flex h-full flex-col gap-10 p-6 sm:p-8 lg:p-10">
          <div className="flex items-center justify-between gap-4">
            <Wordmark inverse />
            <Link to="/" className="text-sm text-inverse-foreground/75 hover:text-inverse-foreground lg:hidden">
              Finish later
            </Link>
          </div>
          <nav aria-label="Setup steps">
            <ol className="flex gap-2 lg:flex-col lg:gap-1">
              {STEPS.map((entry, position) => {
                const current = entry.id === step
                const finished = Boolean(done?.[entry.id]) && !current
                return (
                  <li key={entry.id} className="min-w-0 flex-1 lg:flex-none">
                    <Link
                      to="/setup"
                      search={{ step: entry.id }}
                      aria-current={current ? 'step' : undefined}
                      className={cn(
                        'flex items-center gap-3 py-2 lg:px-3',
                        current
                          ? 'text-inverse-foreground'
                          : 'text-inverse-foreground/60 hover:text-inverse-foreground',
                      )}
                    >
                      <span
                        className={cn(
                          'grid size-7 shrink-0 place-items-center rounded-full border text-xs',
                          current && 'border-inverse-foreground bg-inverse-foreground text-inverse',
                          finished && 'border-primary bg-primary text-primary-foreground',
                          !current && !finished && 'border-inverse-foreground/40',
                        )}
                      >
                        {finished ? <IconCheck className="size-3.5" /> : position + 1}
                      </span>
                      <span className="hidden flex-col lg:flex">
                        <span className="text-sm font-medium">{entry.title}</span>
                        <span className="text-xs text-inverse-foreground/60">{entry.short}</span>
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ol>
          </nav>
          <div className="mt-auto hidden flex-col gap-2 lg:flex">
            <p className="text-sm text-pretty text-inverse-foreground/75">
              Leave whenever you like: the overview keeps your place.
            </p>
            <Link to="/" className="text-sm font-medium text-inverse-foreground hover:underline">
              Finish later
            </Link>
          </div>
        </div>
      </aside>
      <main className="flex justify-center px-6 py-10 sm:px-10 lg:py-16">
        <div className="flex w-full max-w-3xl flex-col gap-8" key={step} data-step={index}>
          {!asked && !done ? <Skeleton className="h-96 rounded-none" /> : null}
          {(asked || done) && step === 'instance' ? <Instance /> : null}
          {step === 'server' ? <Server /> : null}
          {step === 'agent' ? <Agent /> : null}
          {step === 'done' ? <Done /> : null}
        </div>
      </main>
    </div>
  )
}
