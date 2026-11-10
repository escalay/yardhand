/**
 * Adding a connection, in the order such flows usually take (paste → sign in → see what it brings → go live):
 * paste an address and the gateway looks at it (MCP or REST, what sign-in it wants, which tools), give it a key or
 * approve OAuth in a new tab, name it, choose whether its changes wait for review, and add it.
 */
import { IconArrowRight, IconExternalLink, IconSearch } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, type Probe, unwrap } from '@/api/client'
import { useLive } from '@/shell/live'
import { Mono } from '@/ui/Code'
import { cn } from '@/ui/cn'
import { Field } from '@/ui/Field'
import { plural } from '@/ui/format'
import { Illustration } from '@/ui/Illustration'
import { Page, PageHeader, Section } from '@/ui/Page'
import { Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'
import { RadioGroup, RadioGroupItem } from '@/ui/shadcn/radio-group'
import { draftOf, ID_PATTERN, type KeyStyle, kindLabel, offersLine, readsOf, stageOf } from './connections.rules'

const PREVIEW = 8

const Choice = ({ value, title, children }: { value: string; title: string; children: React.ReactNode }) => (
  <label className="flex cursor-pointer gap-3 border border-border bg-card p-4 transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-mist/50">
    <RadioGroupItem value={value} className="mt-0.5" />
    <span className="flex flex-col gap-1">
      <span className="text-sm font-medium">{title}</span>
      <span className="text-sm text-muted-foreground">{children}</span>
    </span>
  </label>
)

const Found = ({ probe }: { probe: Probe }) => (
  <div className="flex flex-col gap-3 border border-border bg-card p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Status tone="ok">
        {kindLabel(probe.kind)}
        {probe.server ? ` · ${probe.server}` : ''}
      </Status>
      <span className="text-sm text-muted-foreground">
        {plural(probe.toolCount ?? 0, 'tool')} · {readsOf(probe)} only read
      </span>
    </div>
    {probe.tools.length ? (
      <ul className="flex flex-col border-t border-border">
        {probe.tools.slice(0, PREVIEW).map((tool) => (
          <li
            key={tool.name}
            className="flex flex-col gap-0.5 border-b border-border py-2.5 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4"
          >
            <Mono className="w-56 shrink-0 truncate">{tool.name}</Mono>
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{tool.summary}</span>
            <span className="text-xs text-faint-foreground">{tool.readOnly ? 'reads' : 'changes things'}</span>
          </li>
        ))}
      </ul>
    ) : null}
    {(probe.toolCount ?? 0) > PREVIEW ? (
      <span className="text-sm text-muted-foreground">and {(probe.toolCount ?? 0) - PREVIEW} more</span>
    ) : null}
    {offersLine(probe.offers) ? (
      <p className="border-t border-border pt-3 text-sm text-pretty">
        It also brings {offersLine(probe.offers)}: agents get them too, so they use its tools the way it intends.
      </p>
    ) : null}
  </div>
)

const Done = ({
  id,
  title,
  tools,
  waiting,
  fromSetup,
}: {
  id: string
  title: string
  tools: number
  waiting: number
  fromSetup?: boolean
}) => (
  <div className="flex flex-col items-center gap-6 border border-border bg-card px-6 py-14 text-center">
    <Illustration name="celebrate" className="h-40 w-auto" />
    <div className="flex max-w-md flex-col gap-2">
      <h2 className="text-2xl tracking-tight text-balance">
        {title} is <em className="font-semibold italic">live</em>
      </h2>
      <p className="text-sm text-pretty text-muted-foreground">
        {plural(tools, 'tool')} ready for every agent you allow.
        {waiting ? ` ${plural(waiting, 'tool')} wait for your review first.` : ''} Try one now to see what an agent gets
        back.
      </p>
    </div>
    <div className="flex flex-wrap justify-center gap-2">
      {fromSetup ? (
        <Button asChild variant="primary">
          <Link to="/setup" search={{ step: 'agent' }}>
            Back to the setup <IconArrowRight />
          </Link>
        </Button>
      ) : null}
      <Button asChild variant={fromSetup ? 'muted' : 'primary'}>
        <Link to="/tools" search={{ upstream: id }}>
          Try one of its tools <IconArrowRight />
        </Link>
      </Button>
      <Button asChild variant="muted">
        <Link to="/agents/new">Give an agent a key</Link>
      </Button>
      <Button asChild variant="ghost">
        <Link to="/connections/$id" params={{ id }}>
          Open {title}
        </Link>
      </Button>
    </div>
  </div>
)

export const NewConnection = ({ fromSetup }: { fromSetup?: boolean } = {}) => {
  const queries = useQueryClient()
  const { listen } = useLive()
  const [url, setUrl] = useState('')
  const [keyStyle, setKeyStyle] = useState<KeyStyle>('bearer')
  const [header, setHeader] = useState('x-api-key')
  const [secret, setSecret] = useState('')
  const [id, setId] = useState('')
  const [title, setTitle] = useState('')
  const [trust, setTrust] = useState<'trusted' | 'review'>('review')
  const [oauthPending, setOauthPending] = useState(false)

  const look = useMutation({
    mutationFn: (withKey: boolean) =>
      unwrap(
        api.POST('/api/upstreams/probe', {
          body: {
            url: url.trim(),
            ...(withKey && secret
              ? {
                  auth:
                    keyStyle === 'header'
                      ? { type: 'header', header, value: secret }
                      : { type: 'bearer', value: secret },
                }
              : {}),
          },
        }),
      ),
    onSuccess: (probe) => {
      setId((current) => current || probe.suggested.id)
      setTitle((current) => current || probe.suggested.title)
    },
  })
  const probe = look.data
  const stage = stageOf(probe)

  const add = useMutation({
    mutationFn: async () => {
      if (!probe) throw new Error('Look at the address first.')
      // Opened now, while the click still counts, so the browser doesn't block it; pointed at the approval page below
      const tab = probe.auth.needed === 'oauth' ? window.open('', '_blank') : null
      const made = await unwrap(
        api.POST('/api/upstreams', {
          body: draftOf({ probe, id, title, trust, key: secret ? { style: keyStyle, header, value: secret } : null }),
        }),
      )
      if (probe.auth.needed === 'oauth') {
        const connect = await unwrap(api.POST('/api/upstreams/{id}/connect', { params: { path: { id } } }))
        if (connect.authorizeUrl && tab) tab.location.href = connect.authorizeUrl
        else tab?.close()
        if (!connect.connected) setOauthPending(true)
      }
      return made
    },
    onSuccess: () => queries.invalidateQueries({ queryKey: ['upstreams'] }),
  })

  // After approving in the other tab the gateway syncs it; the sync event closes the wait here
  useEffect(
    () =>
      listen(({ type, data }) => {
        if (type === 'sync' && (data as { upstream: string }).upstream === id) {
          setOauthPending(false)
          void queries.invalidateQueries({ queryKey: ['upstream', id] })
        }
      }),
    [listen, id, queries],
  )

  const made = add.data
  if (made && !oauthPending)
    return (
      <Page className="max-w-3xl">
        <Done
          id={made.id}
          title={made.title}
          tools={made.sync?.added.length ?? made.toolCount}
          waiting={made.sync?.pending.length ?? 0}
          fromSetup={fromSetup}
        />
      </Page>
    )
  if (made && oauthPending)
    return (
      <Page className="max-w-3xl">
        <div className="flex flex-col items-center gap-5 border border-border bg-card px-6 py-14 text-center">
          <Illustration name="sign-in" className="h-40 w-auto" />
          <h2 className="text-2xl tracking-tight">Approve it in the other tab</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Sign in to {made.title} there and allow access. This page moves on by itself the moment it's connected.
          </p>
          <Status tone="live">Waiting for the approval</Status>
          <Button variant="ghost" onClick={() => setOauthPending(false)}>
            I'll finish later
          </Button>
        </div>
      </Page>
    )

  const idProblem =
    id && !ID_PATTERN.test(id) ? 'Lowercase letters, digits and dashes; it starts every tool name.' : null

  return (
    <Page className="max-w-3xl">
      <PageHeader
        label="Connections"
        title={
          <>
            Add a <em>connection</em>
          </>
        }
      >
        An MCP server, or a REST API with an OpenAPI spec. Its tools become tools every agent you allow can use.
      </PageHeader>

      <Section title="1 · Address">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault()
            look.mutate(Boolean(secret))
          }}
        >
          <Input
            type="url"
            required
            autoFocus
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://mcp.notion.com/mcp"
            aria-label="Address"
            className="font-mono"
          />
          <Button type="submit" disabled={!url.trim() || look.isPending}>
            <IconSearch /> {look.isPending ? 'Looking…' : 'Look'}
          </Button>
        </form>
        {look.error ? <p className="text-sm text-error">{look.error.message}</p> : null}
        {!probe && !look.isPending ? (
          <div className="grid border-t border-l border-border bg-card sm:grid-cols-2">
            <div className="flex flex-col gap-1 border-r border-b border-border p-5">
              <span className="text-sm font-medium">An MCP server</span>
              <span className="text-sm text-muted-foreground">
                Its address usually ends in <Mono>/mcp</Mono>. Servers that sign in with OAuth work too: you approve
                them in a new tab.
              </span>
            </div>
            <div className="flex flex-col gap-1 border-r border-b border-border p-5">
              <span className="text-sm font-medium">A REST API</span>
              <span className="text-sm text-muted-foreground">
                Its base address or its OpenAPI document. Each operation becomes a tool, with the spec as its schema.
              </span>
            </div>
          </div>
        ) : null}
        {stage === 'unusable' && probe ? (
          <div className="flex gap-4 border border-border bg-card p-5">
            <Illustration name="nothing-found" className="h-20 w-auto" />
            <div className="flex flex-col gap-1">
              <Status tone="error">{probe.reachable ? "Can't use this yet" : 'Nothing answered'}</Status>
              <p className="text-sm text-pretty text-muted-foreground">{probe.problem}</p>
            </div>
          </div>
        ) : null}
        {stage === 'oauth' ? (
          <div className="flex flex-col gap-1 border border-border bg-card p-5">
            <Status tone="ok">MCP server · signs in with OAuth</Status>
            <p className="text-sm text-muted-foreground">
              No key needed: when you add it, a new tab opens to sign in and approve. Its tools show up right after.
            </p>
          </div>
        ) : null}
        {stage === 'ready' && probe ? <Found probe={probe} /> : null}
      </Section>

      {stage === 'key' || (secret && probe) ? (
        <Section title="2 · Its key">
          <div className="flex flex-col gap-4 border border-border bg-card p-5">
            <p className="text-sm text-muted-foreground">
              {probe?.problem ?? 'It asks for a key.'} The key is sealed in Yardhand and never shown again.
            </p>
            <RadioGroup
              value={keyStyle}
              onValueChange={(value) => setKeyStyle(value as KeyStyle)}
              className="grid gap-2 sm:grid-cols-2"
            >
              <Choice value="bearer" title="Bearer token">
                Sent as <Mono>Authorization: Bearer …</Mono>
              </Choice>
              <Choice value="header" title="A named header">
                Like <Mono>x-api-key</Mono>
              </Choice>
            </RadioGroup>
            <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
              {keyStyle === 'header' ? (
                <Field label="Header">
                  {(fieldId) => (
                    <Input
                      id={fieldId}
                      value={header}
                      onChange={(event) => setHeader(event.target.value)}
                      className="font-mono"
                    />
                  )}
                </Field>
              ) : null}
              <Field label="Key" className={keyStyle === 'header' ? '' : 'sm:col-span-2'}>
                {(fieldId) => (
                  <Input
                    id={fieldId}
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                )}
              </Field>
            </div>
            <Button
              variant="muted"
              className="self-start"
              disabled={!secret || look.isPending}
              onClick={() => look.mutate(true)}
            >
              {look.isPending ? 'Looking…' : 'Look again with this key'}
            </Button>
          </div>
        </Section>
      ) : null}

      {stage === 'ready' || stage === 'oauth' ? (
        <>
          <Section title={stage === 'oauth' ? '2 · Name it' : '3 · Name it'}>
            <div className="grid gap-4 border border-border bg-card p-5 sm:grid-cols-2">
              <Field label="Title" hint="What you'll see in the app.">
                {(fieldId) => <Input id={fieldId} value={title} onChange={(event) => setTitle(event.target.value)} />}
              </Field>
              <Field
                label="Id"
                hint={
                  <>
                    Tools are named <Mono>{id || 'id'}.tool_name</Mono>
                  </>
                }
                error={idProblem}
              >
                {(fieldId) => (
                  <Input
                    id={fieldId}
                    value={id}
                    onChange={(event) => setId(event.target.value.toLowerCase())}
                    className="font-mono"
                    aria-invalid={Boolean(idProblem)}
                  />
                )}
              </Field>
            </div>
          </Section>
          <Section title="When its tools change">
            <RadioGroup
              value={trust}
              onValueChange={(value) => setTrust(value as 'trusted' | 'review')}
              className="grid gap-2 sm:grid-cols-2"
            >
              <Choice value="review" title="Wait for my review">
                For servers you don't run. A changed description or schema waits until you approve it; agents keep the
                old one meanwhile.
              </Choice>
              <Choice value="trusted" title="Go live on their own">
                For your own servers. Changes reach agents at the next sync, within the hour.
              </Choice>
            </RadioGroup>
          </Section>
          <div
            className={cn(
              'flex flex-col gap-2 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between',
            )}
          >
            <p className="text-sm text-muted-foreground">
              {stage === 'oauth' ? 'A new tab opens to approve it.' : 'Its tools go live as soon as it is added.'}
            </p>
            <Button
              variant="primary"
              size="lg"
              disabled={!id || Boolean(idProblem) || add.isPending}
              onClick={() => add.mutate()}
            >
              {stage === 'oauth' ? <IconExternalLink /> : null}
              {add.isPending ? 'Adding…' : stage === 'oauth' ? 'Add and sign in' : 'Add connection'}
            </Button>
          </div>
          {add.error ? <p className="text-sm text-error">{add.error.message}</p> : null}
        </>
      ) : null}
    </Page>
  )
}
