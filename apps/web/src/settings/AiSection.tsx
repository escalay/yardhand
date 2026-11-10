/**
 * Settings › AI: the gateway's two AI jobs, search by meaning and smart grouping, as settings cards: each setting with
 * what it is for and where its value comes from (set here, .env, or a default) on the left, its control on the right,
 * and the test in the footer. A key is never shown, only whether it is set. Model pickers offer only models that fit
 * their role: TypeSafe's decision models for a TypeSafe decider, chat models otherwise. Smart grouping that isn't set
 * up gets a three-step setup: provider, key, test.
 */
import { IconCheck, IconExternalLink, IconSearch, IconSparkles, IconX } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { api, type Schemas, unwrap } from '@/api/client'
import { RegroupAll } from '@/connections/RegroupAll'
import { Mono } from '@/ui/Code'
import { cn } from '@/ui/cn'
import { Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'
import { RadioGroup, RadioGroupItem } from '@/ui/shadcn/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/shadcn/select'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/shadcn/tooltip'
import { KEY_HELP } from './ai.rules'
import { ModelPicker } from './ModelPicker'
import { SettingsGroup } from './SettingsGroup'

type Job = Schemas['AiJob']
type Provider = Job['provider']['value']
type Providers = Schemas['AiSettings']['providers']
type Patch = Schemas['AiJobPatch']
type Test = Schemas['AiTest']
type From = Job['provider']['from']

export const aiQuery = { queryKey: ['ai'], queryFn: () => unwrap(api.GET('/api/ai')) }

/** Providers that serve TypeSafe's decisions: through OpenRouter, or a server of your own. */
const servesTypeSafe = (provider: Provider) => provider === 'openrouter' || provider === 'custom'
const JEV = 'typesafe/jev-1.14'

const useJob = (job: Job['job']) => {
  const queries = useQueryClient()
  const save = useMutation({
    mutationFn: (body: Patch) => unwrap(api.PATCH('/api/ai/{job}', { params: { path: { job } }, body })),
    onSuccess: (data) => {
      queries.setQueryData(['ai'], data)
      void queries.invalidateQueries({ queryKey: ['system'] })
      void queries.invalidateQueries({ queryKey: ['ai', 'models'] })
    },
    onError: (error) => toast.error(error.message),
  })
  const test = useMutation({
    mutationFn: () => unwrap(api.POST('/api/ai/{job}/test', { params: { path: { job } } })),
  })
  return { save, test }
}

/** Where a value comes from, as a small badge; the .env one names its variable on hover. */
const Source = ({ from, env, onReset }: { from: From; env: string | null; onReset?: () => void }) => {
  const badge = (
    <span
      className={cn(
        'inline-flex h-5 items-center px-1.5 text-[11px] tracking-wide uppercase',
        from === 'settings' && 'bg-mist text-primary',
        from === 'env' && 'bg-muted text-muted-foreground',
        from === 'default' && 'border border-border text-faint-foreground',
      )}
    >
      {from === 'settings' ? 'Set here' : from === 'env' ? '.env' : 'Default'}
    </span>
  )
  return (
    <span className="flex items-center gap-2">
      {from === 'env' && env ? (
        <Tooltip>
          <TooltipTrigger asChild>{badge}</TooltipTrigger>
          <TooltipContent>
            <Mono className="text-xs">{env}</Mono>
          </TooltipContent>
        </Tooltip>
      ) : (
        badge
      )}
      {from === 'settings' && onReset ? (
        <button
          type="button"
          onClick={onReset}
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Reset
        </button>
      ) : null}
    </span>
  )
}

/** One setting: what it is and where it comes from on the left, its control on the right. */
const Setting = ({
  label,
  help,
  source,
  children,
}: {
  label: string
  help: ReactNode
  source?: ReactNode
  children: ReactNode
}) => (
  <div className="grid grid-cols-1 gap-x-10 gap-y-3 px-5 py-5 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-pretty text-muted-foreground">{help}</span>
      {source}
    </div>
    <div className="flex min-w-0 flex-col gap-2 md:max-w-xl">{children}</div>
  </div>
)

const KeyControl = ({ job, onSave }: { job: Job; onSave: (patch: Patch) => void }) => {
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState('')
  if (editing)
    return (
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          onSave({ key: key.trim() })
          setEditing(false)
          setKey('')
        }}
      >
        <Input
          autoFocus
          type="password"
          autoComplete="off"
          value={key}
          placeholder="Paste the new key"
          aria-label="New key"
          onChange={(event) => setKey(event.target.value)}
        />
        <Button type="submit" variant="primary" disabled={key.trim().length < 8}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </form>
    )
  return (
    <div className="flex h-9 items-center justify-between gap-3 border border-border bg-background pr-1 pl-3">
      <span
        className={cn('font-mono text-sm tracking-widest', !job.key.set && 'tracking-normal text-muted-foreground')}
      >
        {job.key.set ? '••••••••••••••••' : 'No key yet'}
      </span>
      <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
        {job.key.set ? 'Replace' : 'Add a key'}
      </Button>
    </div>
  )
}

const AddressControl = ({ job, onSave }: { job: Job; onSave: (patch: Patch) => void }) => (
  <form
    className="flex gap-2"
    onSubmit={(event) => {
      event.preventDefault()
      const value = new FormData(event.currentTarget).get('baseUrl')
      if (typeof value === 'string' && value.trim()) onSave({ baseUrl: value.trim() })
    }}
  >
    <Input
      key={job.baseUrl.value}
      name="baseUrl"
      defaultValue={job.baseUrl.value}
      className="font-mono text-[13px]"
      aria-label="Address"
    />
    <Button type="submit" variant="muted">
      Save
    </Button>
  </form>
)

const ProviderControl = ({
  value,
  providers,
  onPick,
}: {
  value: Provider
  providers: Providers
  onPick: (provider: Provider) => void
}) => (
  <Select value={value} onValueChange={(next) => onPick(next as Provider)}>
    <SelectTrigger aria-label="Provider" className="h-auto w-full py-2">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {providers.map((provider) => (
        <SelectItem key={provider.id} value={provider.id}>
          <span className="flex flex-col items-start">
            <span>{provider.title}</span>
            <Mono className="text-xs text-muted-foreground">{provider.baseUrl || 'your address'}</Mono>
          </span>
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
)

/** TypeSafe's decisions or a chat model, as a segmented choice; TypeSafe only where the provider serves it. */
const DeciderKind = ({
  job,
  onSave,
}: {
  job: Job & { deciderProtocol: NonNullable<Job['deciderProtocol']>; writerModel: NonNullable<Job['writerModel']> }
  onSave: (patch: Patch) => void
}) => {
  const typesafe = servesTypeSafe(job.provider.value)
  const option = (kind: 'typesafe' | 'openai', title: string, disabled = false) => (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={job.deciderProtocol.value === kind}
      onClick={() =>
        onSave(
          kind === 'typesafe'
            ? { deciderProtocol: 'typesafe', deciderModel: JEV }
            : { deciderProtocol: 'openai', deciderModel: job.writerModel.value },
        )
      }
      className={cn(
        'h-8 flex-1 px-3 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        job.deciderProtocol.value === kind
          ? 'bg-card text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {title}
    </button>
  )
  return (
    <div className="flex border border-border bg-muted p-0.5">
      {typesafe ? (
        option('typesafe', 'TypeSafe decisions')
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex flex-1">{option('typesafe', 'TypeSafe decisions', true)}</span>
          </TooltipTrigger>
          <TooltipContent>TypeSafe’s decisions come through OpenRouter or your own server.</TooltipContent>
        </Tooltip>
      )}
      {option('openai', 'Chat model')}
    </div>
  )
}

const TestResult = ({ result }: { result: Test }) => (
  <ul className="flex flex-col gap-1.5 border-t border-border px-5 py-4 text-sm">
    {result.checks.map((check) => (
      <li key={check.name} className="flex items-start gap-2">
        {check.ok ? (
          <IconCheck className="mt-0.5 size-4 shrink-0 text-ok" />
        ) : (
          <IconX className="mt-0.5 size-4 shrink-0 text-error" />
        )}
        <span>
          <span className="font-medium">{check.name}</span>
          <span className="text-muted-foreground">
            {' '}
            · {check.ms} ms · {check.detail}
          </span>
        </span>
      </li>
    ))}
  </ul>
)

/** After setup: every connection regrouped in one sitting, each previewed before anything changes. */
const RegroupOffer = () => (
  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
    <p className="text-sm">Ready. Regroup your connections: each shows every move first and keeps your switches.</p>
    <RegroupAll />
  </div>
)

/** Provider → key → test, for smart grouping that isn't set up yet. */
const GroupingSetup = ({ providers, onDone }: { providers: Providers; onDone: () => void }) => {
  const { save, test } = useJob('grouping')
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [provider, setProvider] = useState<Provider>('openrouter')
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const help = KEY_HELP[provider]
  const needsAddress = provider === 'custom' || provider === 'local'
  return (
    <div className="flex flex-col gap-5 px-5 py-5">
      <ol className="grid grid-cols-3 gap-2">
        {['Provider', 'Key', 'Test'].map((name, index) => (
          <li
            key={name}
            className={cn(
              'border-t-2 pt-2 text-xs tracking-wide uppercase',
              step > index ? 'border-primary text-foreground' : 'border-border text-muted-foreground',
            )}
          >
            {index + 1} · {name}
          </li>
        ))}
      </ol>
      {step === 1 ? (
        <>
          <RadioGroup
            value={provider}
            onValueChange={(value) => setProvider(value as Provider)}
            className="grid gap-2 sm:grid-cols-2"
          >
            {providers.map((option) => (
              <label
                key={option.id}
                className={cn(
                  'flex cursor-pointer items-start gap-3 border p-3 text-sm',
                  provider === option.id ? 'border-primary/50 bg-mist/40' : 'border-border',
                )}
              >
                <RadioGroupItem value={option.id} className="mt-0.5" />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{option.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {option.id === 'openrouter'
                      ? 'Recommended: Jev decides, Flash-Lite writes.'
                      : servesTypeSafe(option.id)
                        ? 'Any OpenAI-compatible server.'
                        : 'Chat models decide too (no TypeSafe).'}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
          {needsAddress ? (
            <Input
              value={baseUrl}
              placeholder={providers.find((option) => option.id === provider)?.baseUrl || 'https://…/v1'}
              className="font-mono text-[13px] sm:w-96"
              aria-label="Address"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          ) : null}
          <div>
            <Button variant="primary" onClick={() => setStep(2)}>
              Next: the key
            </Button>
          </div>
        </>
      ) : step === 2 ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate(
              {
                provider,
                ...(needsAddress && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
                ...(key.trim() ? { key: key.trim() } : {}),
              },
              {
                onSuccess: () => {
                  setStep(3)
                  test.mutate()
                },
              },
            )
          }}
        >
          <p className="text-sm text-muted-foreground">
            {help.text}{' '}
            {help.url ? (
              <a href={help.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                Get one <IconExternalLink className="size-3" />
              </a>
            ) : null}
          </p>
          <Input
            autoFocus
            type="password"
            autoComplete="off"
            value={key}
            className="sm:w-96"
            aria-label="Key"
            onChange={(event) => setKey(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">Sealed in Yardhand’s vault; never shown again.</p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button type="submit" variant="primary" disabled={(provider !== 'local' && !key.trim()) || save.isPending}>
              Save and test
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          {test.isPending ? <p className="text-sm text-muted-foreground">Asking both models…</p> : null}
          {test.data ? <TestResult result={test.data} /> : null}
          {test.error ? <p className="text-sm text-error">{test.error.message}</p> : null}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button variant="ghost" disabled={test.isPending} onClick={() => test.mutate()}>
              Test again
            </Button>
            {test.data?.ok ? (
              <Button variant="primary" onClick={onDone}>
                Done
              </Button>
            ) : null}
          </div>
          {test.data?.ok ? <RegroupOffer /> : null}
        </div>
      )}
    </div>
  )
}

const JobCard = ({ job, providers }: { job: Job; providers: Providers }) => {
  const { save, test } = useJob(job.job)
  const [settingUp, setSettingUp] = useState(false)
  const onSave = (patch: Patch) => save.mutate(patch)
  const grouping = job.job === 'grouping'
  const setup = grouping && (!job.ready || settingUp)
  const showAddress =
    job.provider.value === 'custom' || job.provider.value === 'local' || job.baseUrl.from !== 'default'
  const Icon = grouping ? IconSparkles : IconSearch
  return (
    <div className="border border-border bg-card">
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-5">
        <div className="flex gap-4">
          <span className="grid size-9 shrink-0 place-items-center border border-border bg-muted">
            <Icon className="size-4 text-primary" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="font-medium">{job.title}</span>
            <span className="max-w-2xl text-sm text-pretty text-muted-foreground">{job.does}</span>
          </div>
        </div>
        <Status tone={job.ready ? 'ok' : 'neutral'}>{job.ready ? 'Ready' : 'Not set up'}</Status>
      </div>
      {setup ? (
        <GroupingSetup providers={providers} onDone={() => setSettingUp(false)} />
      ) : (
        <>
          <div className="divide-y divide-border">
            {grouping ? (
              <Setting
                label="Provider"
                help="Where both models run."
                source={
                  <Source from={job.provider.from} env={job.provider.env} onReset={() => onSave({ provider: null })} />
                }
              >
                <ProviderControl
                  value={job.provider.value}
                  providers={providers}
                  onPick={(provider) => onSave({ provider })}
                />
              </Setting>
            ) : null}
            {grouping && showAddress ? (
              <Setting
                label="Address"
                help="The server’s OpenAI-compatible API, ending in /v1."
                source={
                  <Source from={job.baseUrl.from} env={job.baseUrl.env} onReset={() => onSave({ baseUrl: null })} />
                }
              >
                <AddressControl job={job} onSave={onSave} />
              </Setting>
            ) : null}
            <Setting
              label="Key"
              help={
                grouping
                  ? 'Sealed in Yardhand’s vault, never shown again.'
                  : 'An OpenRouter key; sealed, never shown again.'
              }
              source={<Source from={job.key.from} env={job.key.env} onReset={() => onSave({ key: null })} />}
            >
              <KeyControl job={job} onSave={onSave} />
            </Setting>
            {job.model ? (
              <Setting
                label="Model"
                help="Set by agent-api-kit. A new embedding model would re-embed every tool, so it’s fixed here."
              >
                <div className="flex h-9 items-center border border-border bg-muted px-3 text-sm text-muted-foreground">
                  Gemini Embedding 2 <Mono className="ml-2 text-xs">google/gemini-embedding-2</Mono>
                </div>
              </Setting>
            ) : null}
            {job.writerModel ? (
              <Setting
                label="Names groups"
                help="Reads a connection’s tools and writes each group’s name and purpose. Any chat model."
                source={
                  <Source
                    from={job.writerModel.from}
                    env={job.writerModel.env}
                    onReset={() => onSave({ writerModel: null })}
                  />
                }
              >
                <ModelPicker
                  provider={job.provider.value}
                  fits="writer"
                  value={job.writerModel.value}
                  label="Model that names groups"
                  onPick={(model) => onSave({ writerModel: model })}
                />
              </Setting>
            ) : null}
            {job.deciderModel && job.deciderProtocol && job.writerModel ? (
              <Setting
                label="Files tools"
                help={
                  job.deciderProtocol.value === 'typesafe'
                    ? 'TypeSafe’s System One picks a group for every tool, with how sure it is.'
                    : 'A chat model is asked to pick a group for every tool.'
                }
                source={
                  <Source
                    from={job.deciderModel.from}
                    env={job.deciderModel.env}
                    onReset={() => onSave({ deciderModel: null, deciderProtocol: null })}
                  />
                }
              >
                <DeciderKind
                  job={{ ...job, deciderProtocol: job.deciderProtocol, writerModel: job.writerModel }}
                  onSave={onSave}
                />
                <ModelPicker
                  provider={job.provider.value}
                  fits={job.deciderProtocol.value === 'typesafe' ? 'typesafe' : 'chat'}
                  value={job.deciderModel.value}
                  label="Model that files tools"
                  onPick={(model) => onSave({ deciderModel: model })}
                />
              </Setting>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/40 px-5 py-3">
            <span className="text-xs text-muted-foreground">
              {grouping ? (
                <>
                  Starts from <Mono className="text-xs">GATEWAY_AI_GROUPING_*</Mono> in .env; what you set here wins.
                </>
              ) : (
                <>
                  Starts from <Mono className="text-xs">OPENROUTER_API_KEY</Mono> in .env; a key set here wins.
                </>
              )}
            </span>
            <span className="flex gap-2">
              {grouping ? (
                <Button size="sm" variant="ghost" onClick={() => setSettingUp(true)}>
                  Set up again
                </Button>
              ) : null}
              {grouping && job.ready ? <RegroupAll /> : null}
              <Button size="sm" variant="muted" disabled={test.isPending} onClick={() => test.mutate()}>
                {test.isPending ? 'Testing…' : grouping ? 'Test both models' : 'Test'}
              </Button>
            </span>
          </div>
          {test.data ? <TestResult result={test.data} /> : null}
        </>
      )}
    </div>
  )
}

export const AiSection = () => {
  const ai = useQuery(aiQuery)
  return (
    <SettingsGroup
      title="AI"
      description="Two jobs that use a model. Each starts from .env and what you set here wins; keys are sealed and never shown."
    >
      {ai.isPending ? (
        <Skeleton className="h-48 rounded-none" />
      ) : ai.error ? (
        <p className="text-sm text-error">{ai.error.message}</p>
      ) : (
        <div className="flex flex-col gap-6">
          {ai.data.jobs.map((job) => (
            <JobCard key={job.job} job={job} providers={ai.data.providers} />
          ))}
        </div>
      )}
    </SettingsGroup>
  )
}
