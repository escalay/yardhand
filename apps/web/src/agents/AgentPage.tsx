/**
 * One agent: how it's used, its setup (without the key: that was shown once), what it may reach and do, and revoking
 * it. A key that never called waits here for its first call, live.
 */
import { IconArrowRight } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { EntityActivity } from '@/activity/EntityActivity'
import { api, unwrap } from '@/api/client'
import { shortTitleOf } from '@/connections/connections.rules'
import { upstreamsQuery } from '@/connections/queries'
import { expiryOf } from '@/packs/packs.rules'
import { packsQuery } from '@/packs/queries'
import { Empty } from '@/ui/Empty'
import { EntityHeader, EntityTabs } from '@/ui/Entity'
import { ago, plural } from '@/ui/format'
import { Page, Section } from '@/ui/Page'
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
import { RadioGroup, RadioGroupItem } from '@/ui/shadcn/radio-group'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { reachOf } from './agents.rules'
import { FirstCall } from './FirstCall'
import { type PackChoice, PackPicker } from './PackPicker'
import { clientQuery } from './queries'
import { Setup } from './Setup'

export const AgentPage = ({ id, tab = 'overview' }: { id: string; tab?: 'overview' | 'activity' }) => {
  const queries = useQueryClient()
  const navigate = useNavigate()
  const client = useQuery(clientQuery(id))
  const upstreams = useQuery(upstreamsQuery)
  const [scope, setScope] = useState<'read' | 'write'>('write')
  const [everything, setEverything] = useState(true)
  const [chosen, setChosen] = useState<string[]>([])
  const [packChoice, setPackChoice] = useState<PackChoice>({ packs: [], pack: '' })
  const packs = useQuery(packsQuery)
  useEffect(() => {
    if (!client.data) return
    setScope(client.data.scope)
    setPackChoice({ packs: client.data.packs, pack: client.data.pack ?? '' })
    setEverything(client.data.upstreams === 'all')
    setChosen(client.data.upstreams === 'all' ? [] : client.data.upstreams)
  }, [client.data])
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['client', id] })
    void queries.invalidateQueries({ queryKey: ['clients'] })
  }
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH('/api/clients/{id}', {
          params: { path: { id } },
          // A pack key's reach is its packs
          body: client.data?.pack ? { scope, ...packChoice } : { scope, upstreams: everything ? 'all' : chosen },
        }),
      ),
    onSuccess: () => {
      toast.success('Saved. It applies to its next call.')
      refresh()
    },
    onError: (error) => toast.error(error.message),
  })
  const revoke = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/clients/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      toast.success('Revoked. Its key stopped working just now.')
      refresh()
      void navigate({ to: '/agents' })
    },
  })

  if (client.isPending)
    return (
      <Page>
        <Skeleton className="h-64 rounded-none" />
      </Page>
    )
  if (client.error)
    return (
      <Page>
        <Empty illustration="not-found" title="No agent by that id">
          {client.error.message}
        </Empty>
      </Page>
    )
  const row = client.data
  const expiry = expiryOf(row.expiresAt)
  const changed =
    scope !== row.scope ||
    (Boolean(row.pack) &&
      (packChoice.pack !== row.pack || JSON.stringify(packChoice.packs) !== JSON.stringify(row.packs))) ||
    (!row.pack && everything !== (row.upstreams === 'all')) ||
    (!row.pack &&
      !everything &&
      JSON.stringify([...chosen].sort()) !== JSON.stringify(row.upstreams === 'all' ? [] : [...row.upstreams].sort()))

  return (
    <Page>
      <EntityHeader
        crumbs={[
          { label: 'Agents', to: '/agents' },
          { label: row.kind === 'oauth' ? 'OAuth' : 'Key', to: `/agents/${id}` },
        ]}
        title={row.name}
        actions={
          <Button asChild variant="muted">
            <Link to="/activity" search={{ outcome: 'all', client: id }}>
              Its calls <IconArrowRight />
            </Link>
          </Button>
        }
      >
        {reachOf(row)}. Made {ago(row.createdAt)}.{row.expiresAt ? ` ${expiry.text}.` : ''}
      </EntityHeader>
      <EntityTabs
        active={tab}
        onPick={(next) =>
          void navigate({
            to: '/agents/$id',
            params: { id },
            search: next === 'activity' ? { tab: 'activity' } : {},
            replace: true,
          })
        }
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'activity', label: 'Activity', count: row.usage.calls7d || null },
        ]}
      />

      {tab === 'activity' ? (
        <EntityActivity filter={{ client: id }} />
      ) : row.revokedAt ? (
        <Status tone="neutral">Revoked {ago(row.revokedAt)}: its key no longer works.</Status>
      ) : expiry.expired ? (
        <Status tone="neutral">
          Expired {ago(row.expiresAt)}: its key no longer works. Issue a new one from its pack.
        </Status>
      ) : (
        <>
          <div className="grid border-t border-l border-border bg-card sm:grid-cols-3">
            {[
              ['Last call', row.usage.lastCallAt ? ago(row.usage.lastCallAt) : 'never'],
              ['This week', plural(row.usage.calls7d, 'call')],
              ['Answers capped at', `${row.resultCap.toLocaleString('en-GB')} tokens`],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1 border-r border-b border-border p-5">
                <span className="text-xs tracking-wide text-muted-foreground uppercase">{label}</span>
                <span className="text-base">{value}</span>
              </div>
            ))}
          </div>
          {row.usage.lastCallAt ? null : <FirstCall clientId={id} name={row.name} since={row.usage.lastCallAt} />}
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_24rem]">
            <Section title="Setup">
              <Setup id={id} apiKey={null} />
              <p className="text-sm text-muted-foreground">
                The key was shown once, when it was made. Lost it? Revoke this agent and make a new one.
              </p>
            </Section>
            <div className="flex flex-col gap-8">
              <Section title="What it may do">
                <RadioGroup
                  value={scope}
                  onValueChange={(value) => setScope(value as 'read' | 'write')}
                  className="border border-border bg-card"
                >
                  {(
                    [
                      ['write', 'Read and change things'],
                      ['read', 'Only read'],
                    ] as const
                  ).map(([value, label]) => (
                    <label
                      key={value}
                      className="flex cursor-pointer items-center gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0"
                    >
                      <RadioGroupItem value={value} /> {label}
                    </label>
                  ))}
                </RadioGroup>
              </Section>
              <Section title="What it reaches">
                {row.pack ? (
                  <div className="flex flex-col gap-2">
                    <PackPicker packs={packs.data?._embedded.packs ?? []} value={packChoice} onChange={setPackChoice} />
                    <span className="text-sm text-muted-foreground">
                      It sees and runs only what its packs hold. {expiry.text}.
                    </span>
                  </div>
                ) : (
                  <div className="border border-border bg-card">
                    <label className="flex cursor-pointer items-center gap-3 border-b border-border px-4 py-3 text-sm">
                      <Checkbox checked={everything} onCheckedChange={(checked) => setEverything(checked === true)} />
                      Every connection, now and later
                    </label>
                    {everything
                      ? null
                      : (upstreams.data?._embedded.upstreams ?? []).map((upstream) => (
                          <label
                            key={upstream.id}
                            className="flex cursor-pointer items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-b-0"
                          >
                            <Checkbox
                              checked={chosen.includes(upstream.id)}
                              onCheckedChange={(checked) =>
                                setChosen((current) =>
                                  checked === true
                                    ? [...current, upstream.id]
                                    : current.filter((value) => value !== upstream.id),
                                )
                              }
                            />
                            {shortTitleOf(upstream.title)}
                          </label>
                        ))}
                  </div>
                )}
                <Button
                  variant="primary"
                  disabled={
                    !changed ||
                    save.isPending ||
                    (!row.pack && !everything && !chosen.length) ||
                    (Boolean(row.pack) && !packChoice.packs.length)
                  }
                  onClick={() => save.mutate()}
                >
                  {save.isPending ? 'Saving…' : 'Save'}
                </Button>
              </Section>
              <Section title="Revoke">
                <div className="flex flex-col gap-3 border border-border bg-card p-5">
                  <p className="text-sm text-muted-foreground">
                    Its key stops working at once. Its calls stay in the log.
                  </p>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" className="self-start text-error hover:text-error">
                        Revoke {row.name}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Revoke {row.name}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Anything using its key gets refused from its next call. This can't be undone: a new key means
                          pasting the setup again.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Keep it</AlertDialogCancel>
                        <AlertDialogAction variant="danger" onClick={() => revoke.mutate()}>
                          Revoke
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </Section>
            </div>
          </div>
        </>
      )}
    </Page>
  )
}
