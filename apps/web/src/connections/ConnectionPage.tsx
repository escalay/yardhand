/**
 * One connection: how it is (status, last sync, today's calls and speed), what it offers (its tools, manual,
 * playbooks and links, in tabs), and everything the owner can change: sync now, connect again (OAuth), the key,
 * review or trust, offering its playbooks, switch off, remove.
 */
import { IconArrowRight, IconExternalLink, IconRefresh } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { EntityActivity } from '@/activity/EntityActivity'
import { api, unwrap } from '@/api/client'
import { overviewQuery } from '@/shell/queries'
import { Mono } from '@/ui/Code'
import { Empty } from '@/ui/Empty'
import { EntityHeader, EntityTabs } from '@/ui/Entity'
import { Field } from '@/ui/Field'
import { ago, duration, plural } from '@/ui/format'
import { Page, Section } from '@/ui/Page'
import { HEALTH, Status } from '@/ui/Status'
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
import { Input } from '@/ui/shadcn/input'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { Switch } from '@/ui/shadcn/switch'
import { Tabs, TabsContent } from '@/ui/shadcn/tabs'
import { AccountsTab } from './AccountsTab'
import { type ConnectionTab, kindLabel, offersLine, shortTitleOf } from './connections.rules'
import { GroupsView } from './GroupsView'
import { LinksTab } from './LinksTab'
import { ManualTab } from './ManualTab'
import { PlaybooksTab } from './PlaybooksTab'
import { upstreamQuery, upstreamToolsQuery } from './queries'

const Row = ({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) => (
  <div className="flex flex-col gap-3 border-b border-border px-5 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm font-medium">{title}</span>
      <span className="text-sm text-muted-foreground">{children}</span>
    </div>
    {action ? <div className="flex shrink-0 gap-2">{action}</div> : null}
  </div>
)

const KeyEditor = ({ id, onDone }: { id: string; onDone: () => void }) => {
  const queries = useQueryClient()
  const [value, setValue] = useState('')
  const [header, setHeader] = useState('')
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH('/api/upstreams/{id}', {
          params: { path: { id } },
          body: { auth: header ? { type: 'header', header, value } : { type: 'bearer', value } },
        }),
      ),
    onSuccess: () => {
      toast.success('Key replaced. It synced again with the new one.')
      void queries.invalidateQueries({ queryKey: ['upstream', id] })
      onDone()
    },
  })
  return (
    <form
      className="flex flex-col gap-3 border-b border-border bg-muted/50 px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <Field label="Header" hint="Empty for a bearer token.">
          {(fieldId) => (
            <Input
              id={fieldId}
              value={header}
              onChange={(event) => setHeader(event.target.value)}
              placeholder="x-api-key"
              className="font-mono"
            />
          )}
        </Field>
        <Field label="New key" error={save.error?.message ?? null}>
          {(fieldId) => (
            <Input
              id={fieldId}
              type="password"
              autoComplete="off"
              required
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!value || save.isPending}>
          {save.isPending ? 'Saving…' : 'Replace key'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export const ConnectionPage = ({ id, tab = 'tools' }: { id: string; tab?: ConnectionTab }) => {
  const queries = useQueryClient()
  const navigate = useNavigate()
  const upstream = useQuery(upstreamQuery(id))
  const tools = useQuery(upstreamToolsQuery(id))
  const overview = useQuery(overviewQuery)
  const [editingKey, setEditingKey] = useState(false)
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['upstream', id] })
    void queries.invalidateQueries({ queryKey: ['upstreams'] })
    void queries.invalidateQueries({ queryKey: ['tools'] })
    void queries.invalidateQueries({ queryKey: ['catalog'] })
  }

  const sync = useMutation({
    mutationFn: () => unwrap(api.POST('/api/upstreams/{id}/sync', { params: { path: { id } } })),
    onSuccess: (summary) => {
      if (!summary) return refresh()
      const added = summary.added.length + summary.catalog.added.length
      const changed = summary.changed.length + summary.catalog.changed.length
      const removed = summary.removed.length + summary.catalog.removed.length
      const pending = summary.pending.length + summary.catalog.pending.length
      toast.success(
        added + changed + removed + pending
          ? `Synced: ${added} new, ${changed} changed, ${removed} gone${pending ? `, ${pending} waiting for review` : ''}.`
          : 'Synced: nothing changed.',
      )
      refresh()
    },
    onError: (error) => toast.error(error.message),
  })
  const change = useMutation({
    mutationFn: (body: {
      enabled?: boolean
      trust?: 'trusted' | 'review'
      title?: string
      playbooks?: boolean
      linkProxy?: boolean
    }) => unwrap(api.PATCH('/api/upstreams/{id}', { params: { path: { id } }, body })),
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  })
  const connect = useMutation({
    mutationFn: () => unwrap(api.POST('/api/upstreams/{id}/connect', { params: { path: { id } } })),
    onSuccess: (result) => {
      if (result.connected) toast.success('Already connected: its sign-in still works.')
      else if (result.authorizeUrl) window.open(result.authorizeUrl, '_blank', 'noopener')
    },
    onError: (error) => toast.error(error.message),
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/upstreams/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      toast.success('Removed, with its tools and its key.')
      refresh()
      void navigate({ to: '/connections' })
    },
  })

  if (upstream.isPending)
    return (
      <Page>
        <Skeleton className="h-48 rounded-none" />
      </Page>
    )
  if (upstream.error)
    return (
      <Page>
        <Empty
          illustration="not-found"
          title="No connection by that id"
          action={
            <Button asChild variant="muted">
              <Link to="/connections">All connections</Link>
            </Button>
          }
        >
          {upstream.error.message}
        </Empty>
      </Page>
    )
  const row = upstream.data
  const health = HEALTH[row.status] ?? { tone: 'neutral' as const, label: row.status }
  const today = overview.data?.upstreams.find((entry) => entry.id === id)
  const list = tools.data?._embedded.tools ?? []

  return (
    <Page>
      <EntityHeader
        crumbs={[
          { label: 'Connections', to: '/connections' },
          { label: kindLabel(row.kind), to: `/connections/${id}` },
        ]}
        title={shortTitleOf(row.title)}
        actions={
          <>
            <Button variant="muted" onClick={() => sync.mutate()} disabled={sync.isPending}>
              <IconRefresh className={sync.isPending ? 'animate-spin' : ''} />{' '}
              {sync.isPending ? 'Syncing…' : 'Sync now'}
            </Button>
            <Button asChild variant="default">
              <Link to="/tools" search={{ upstream: id }}>
                Its tools <IconArrowRight />
              </Link>
            </Button>
          </>
        }
      >
        {shortTitleOf(row.title) === row.title ? null : (
          <>
            {row.title}
            <br />
          </>
        )}
        <Mono className="break-all">{row.url}</Mono>
      </EntityHeader>

      <div className="grid border-t border-l border-border bg-card sm:grid-cols-4">
        {[
          [
            'Status',
            <Status key="s" tone={row.enabled ? health.tone : 'neutral'}>
              {row.enabled ? health.label : 'Switched off'}
            </Status>,
          ],
          [
            'Offers',
            <span key="o" className="flex flex-col">
              {plural(row.toolCount, 'tool')}
              {offersLine(row.offers) ? (
                <span className="text-xs text-muted-foreground">and {offersLine(row.offers)}</span>
              ) : null}
            </span>,
          ],
          [
            'Today',
            today ? `${plural(today.calls24h, 'call')}${today.failed24h ? `, ${today.failed24h} failed` : ''}` : '–',
          ],
          ['Typical answer', duration(today?.p50Ms)],
        ].map(([label, value]) => (
          <div key={String(label)} className="flex flex-col gap-1 border-r border-b border-border p-5">
            <span className="text-xs tracking-wide text-muted-foreground uppercase">{label}</span>
            <span className="text-base">{value}</span>
          </div>
        ))}
      </div>

      {row.lastError ? (
        <div className="flex flex-col gap-1 border border-error/30 bg-error-soft p-5">
          <Status tone="error">
            Last sync failed {ago(row.syncedAt) === 'never' ? '' : `(last good one ${ago(row.syncedAt)})`}
          </Status>
          <p className="font-mono text-[12.5px] text-pretty">{row.lastError}</p>
          {row.auth === 'oauth' ? (
            <Button variant="primary" size="sm" className="mt-2 self-start" onClick={() => connect.mutate()}>
              <IconExternalLink /> Connect again
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Tabs
          value={tab}
          onValueChange={(next) =>
            void navigate({
              to: '/connections/$id',
              params: { id },
              search: next === 'tools' ? {} : { tab: next as ConnectionTab },
              replace: true,
            })
          }
          className="min-w-0 gap-4"
        >
          <EntityTabs
            active={tab}
            onPick={(next) =>
              void navigate({
                to: '/connections/$id',
                params: { id },
                search: next === 'tools' ? {} : { tab: next as ConnectionTab },
                replace: true,
              })
            }
            tabs={[
              { id: 'tools', label: 'Tools', count: list.length },
              ...(row.kind === 'composio' ? [{ id: 'accounts', label: 'Accounts' }] : []),
              ...(row.offers.manuals ? [{ id: 'manual', label: 'Manual' }] : []),
              ...(row.offers.playbooks ? [{ id: 'playbooks', label: 'Playbooks', count: row.offers.playbooks }] : []),
              ...(row.offers.links ? [{ id: 'links', label: 'Links', count: row.offers.links }] : []),
              ...(row.instructions ? [{ id: 'instructions', label: 'Instructions' }] : []),
              { id: 'activity', label: 'Activity' },
            ]}
          />
          <TabsContent value="tools">
            {tools.isPending ? (
              <Skeleton className="h-40 rounded-none" />
            ) : list.length || row.kind === 'composio' ? (
              <GroupsView upstream={id} tools={list} composio={row.kind === 'composio'} />
            ) : (
              <p className="border border-border bg-card p-5 text-sm text-muted-foreground">
                No tools yet. Sync it once it answers.
              </p>
            )}
          </TabsContent>
          <TabsContent value="accounts">{row.kind === 'composio' ? <AccountsTab upstream={id} /> : null}</TabsContent>
          <TabsContent value="manual">
            <ManualTab upstream={id} />
          </TabsContent>
          <TabsContent value="playbooks">
            <PlaybooksTab upstream={id} offered={row.playbooks} />
          </TabsContent>
          <TabsContent value="links">
            <LinksTab upstream={id} />
          </TabsContent>
          <TabsContent value="instructions">
            <div className="flex flex-col gap-2 border border-border bg-card p-5">
              <span className="text-xs tracking-wide text-muted-foreground uppercase">How it says to use it</span>
              <p className="text-sm whitespace-pre-line text-pretty">{row.instructions}</p>
            </div>
          </TabsContent>
          <TabsContent value="activity">
            <EntityActivity filter={{ upstream: id }} />
          </TabsContent>
        </Tabs>

        <Section title="Settings">
          <div className="border border-border bg-card">
            <Row
              title="Switched on"
              action={
                <Switch
                  checked={row.enabled}
                  onCheckedChange={(enabled) => change.mutate({ enabled })}
                  aria-label="Switched on"
                />
              }
            >
              {row.enabled ? 'Agents can use its tools.' : 'Hidden from every agent; nothing reaches it.'}
            </Row>
            <Row
              title="Review its changes"
              action={
                <Switch
                  checked={row.trust === 'review'}
                  onCheckedChange={(review) => change.mutate({ trust: review ? 'review' : 'trusted' })}
                  aria-label="Review its changes"
                />
              }
            >
              {row.trust === 'review' ? 'Changed tools wait for your approval.' : 'Changes go live at the next sync.'}
            </Row>
            <Row
              title="Sign-in"
              action={
                row.auth === 'oauth' ? (
                  <Button size="sm" variant="muted" onClick={() => connect.mutate()} disabled={connect.isPending}>
                    <IconExternalLink /> Connect again
                  </Button>
                ) : (
                  <Button size="sm" variant="muted" onClick={() => setEditingKey(true)}>
                    {row.auth === 'none' ? 'Add a key' : 'Replace key'}
                  </Button>
                )
              }
            >
              {row.auth === 'oauth'
                ? 'OAuth, approved by you; Yardhand refreshes it.'
                : row.auth === 'none'
                  ? 'None: it answers without a key.'
                  : 'A key, stored sealed.'}{' '}
              Synced <span className="whitespace-nowrap">{ago(row.syncedAt)}</span>.
            </Row>
            {editingKey ? <KeyEditor id={id} onDone={() => setEditingKey(false)} /> : null}
            <Row
              title="Open its links"
              action={
                <Switch
                  checked={row.linkProxy}
                  onCheckedChange={(linkProxy) => change.mutate({ linkProxy })}
                  aria-label="Open its links"
                />
              }
            >
              {row.linkProxy
                ? 'Links to its own host open through Yardhand, with its sign-in.'
                : 'Its links stay as they are; Yardhand never fetches them with its sign-in.'}
            </Row>
            {row.offers.playbooks ? (
              <Row
                title="Offer its playbooks"
                action={
                  <Switch
                    checked={row.playbooks}
                    onCheckedChange={(playbooks) => change.mutate({ playbooks })}
                    aria-label="Offer its playbooks"
                  />
                }
              >
                {row.playbooks
                  ? `Agents see its ${plural(row.offers.playbooks, 'playbook')} as slash commands and in search.`
                  : 'Hidden from agents; you still see them here.'}
              </Row>
            ) : null}
            <Row
              title="Remove"
              action={
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="ghost" className="text-error hover:text-error">
                      Remove
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove {shortTitleOf(row.title)}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Its {plural(row.toolCount, 'tool')} disappear for every agent at once, and its stored key or
                        sign-in is deleted. Past calls stay in the log. Adding it back takes a minute.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep it</AlertDialogCancel>
                      <AlertDialogAction variant="danger" onClick={() => remove.mutate()}>
                        Remove {shortTitleOf(row.title)}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              }
            >
              Its tools, key and settings; the log stays.
            </Row>
          </div>
        </Section>
      </div>
    </Page>
  )
}
