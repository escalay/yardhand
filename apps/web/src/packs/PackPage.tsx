/**
 * One pack: its tools (why each is in, the pack's wording, flags when an upstream moved on), its playbooks and
 * manuals, what its agents read first, and the keys locked to it, with one more issued from here.
 */
import { IconAlertTriangle, IconKey, IconPencil, IconPlus, IconX } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { EntityActivity } from '@/activity/EntityActivity'
import { api, type Schemas, unwrap } from '@/api/client'
import { Mono } from '@/ui/Code'
import { Empty } from '@/ui/Empty'
import { EntityHeader, EntityTabs } from '@/ui/Entity'
import { Field } from '@/ui/Field'
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/shadcn/dialog'
import { Input } from '@/ui/shadcn/input'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { Textarea } from '@/ui/shadcn/textarea'
import { AddPlaybook } from './AddPlaybook'
import { UpstreamChips } from './PacksPage'
import { PackTools } from './PackTools'
import { expiryOf, holdsLine } from './packs.rules'
import { packQuery } from './queries'

type Pack = Schemas['Pack']
type PackItem = Schemas['PackItem']

const ItemList = ({
  items,
  empty,
  onRemove,
  link,
}: {
  items: PackItem[]
  empty: string
  onRemove: (name: string) => void
  link: (item: PackItem) => React.ReactNode
}) =>
  items.length ? (
    <ul>
      {items.map((item) => (
        <li key={item.name} className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex flex-wrap items-baseline gap-x-2">
              {link(item)}
              {item.live ? null : <Status tone="error">Not live</Status>}
            </span>
            {item.description ? (
              <span className="line-clamp-2 text-sm text-muted-foreground">{item.description}</span>
            ) : null}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Take ${item.name} out`}
            onClick={() => onRemove(item.name)}
          >
            <IconX />
          </Button>
        </li>
      ))}
    </ul>
  ) : (
    <p className="border-b border-border px-5 py-4 text-sm text-muted-foreground">{empty}</p>
  )

const EditPack = ({
  pack,
  open,
  onOpenChange,
  onSave,
}: {
  pack: Pack
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (body: Schemas['PackPatch']) => Promise<unknown>
}) => {
  const [title, setTitle] = useState(pack.title)
  const [description, setDescription] = useState(pack.description)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setTitle(pack.title)
          setDescription(pack.description)
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{pack.title}</DialogTitle>
          <DialogDescription>Its keys read the description first, as the server's instructions.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void onSave({ title: title.trim(), description: description.trim() }).then(() => onOpenChange(false))
          }}
        >
          <Field label="Title">
            {(id) => <Input id={id} required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <Field label="What it is for">
            {(id) => (
              <Textarea
                id={id}
                rows={5}
                maxLength={4000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!title.trim()}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Roughly what an agent with this pack's key is told on connecting. */
const Briefing = ({ pack }: { pack: Pack }) => (
  <div className="flex flex-col gap-3 border border-border bg-inverse p-5 font-mono text-[12px] leading-relaxed text-inverse-foreground/85">
    <p className="text-inverse-foreground">
      {pack.title}: {pack.description || '…'}
    </p>
    <p>This key is locked to the pack {pack.title}: the tools listed here are all it reaches.</p>
    {pack.playbooks.length ? <p>Playbooks: {pack.playbooks.map((item) => item.name).join(', ')}.</p> : null}
    <div>
      <p>Tools:</p>
      {pack.tools.slice(0, 8).map((tool) => (
        <p key={tool.name} className="truncate">
          - {tool.name}: {tool.description.split('\n')[0]}
        </p>
      ))}
      {pack.tools.length > 8 ? <p>- … {pack.tools.length - 8} more</p> : null}
    </div>
  </div>
)

export type PackTab = 'overview' | 'tools' | 'playbooks' | 'keys' | 'activity'
const PACK_TABS: PackTab[] = ['overview', 'tools', 'playbooks', 'keys', 'activity']
export const parsePackTab = (raw: Record<string, unknown>): { tab?: PackTab } =>
  PACK_TABS.includes(raw.tab as PackTab) && raw.tab !== 'tools' ? { tab: raw.tab as PackTab } : {}

const GiveAccess = ({ pack, variant = 'primary' }: { pack: Pack; variant?: 'primary' | 'ghost' }) => (
  <Button asChild variant={variant} size={variant === 'ghost' ? 'sm' : 'default'} disabled={!pack.tools.length}>
    <Link to="/agents/new" search={{ pack: pack.name }}>
      <IconKey /> Give access
    </Link>
  </Button>
)

const Keys = ({ pack }: { pack: Pack }) => (
  <div className="flex flex-col border border-border bg-card">
    {pack.keyList.length ? (
      <ul>
        {pack.keyList.map((key) => (
          <li key={key.id} className="border-b border-border px-4 py-3">
            <Link to="/agents/$id" params={{ id: key.id }} className="flex flex-col hover:text-primary">
              <span className="text-sm font-medium">{key.name}</span>
              <span className="text-xs text-muted-foreground">
                {key.scope === 'write' ? 'Reads and changes' : 'Reads only'} · {expiryOf(key.expiresAt).text}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    ) : (
      <p className="px-4 py-4 text-sm text-muted-foreground">No key is locked to it yet.</p>
    )}
    <div className="p-3">
      <GiveAccess pack={pack} variant="ghost" />
    </div>
  </div>
)

export const PackPage = ({ name, tab = 'tools' }: { name: string; tab?: PackTab }) => {
  const queries = useQueryClient()
  const navigate = useNavigate()
  const pack = useQuery(packQuery(name))
  const [editing, setEditing] = useState(false)
  const [addingPlaybook, setAddingPlaybook] = useState(false)
  const patch = useMutation({
    mutationFn: (body: Schemas['PackPatch']) =>
      unwrap(api.PATCH('/api/packs/{name}', { params: { path: { name } }, body })),
    onSuccess: (data) => {
      queries.setQueryData(packQuery(name).queryKey, data)
      void queries.invalidateQueries({ queryKey: ['packs'] })
    },
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/packs/{name}', { params: { path: { name } } })),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['packs'] })
      void navigate({ to: '/packs' })
    },
  })

  if (pack.isPending)
    return (
      <Page>
        <Skeleton className="h-24 rounded-none" />
        <Skeleton className="h-96 rounded-none" />
      </Page>
    )
  if (pack.error)
    return (
      <Page>
        <Empty
          illustration="not-found"
          title={`No pack ${name}`}
          action={
            <Button asChild variant="muted">
              <Link to="/packs">All packs</Link>
            </Button>
          }
        >
          {pack.error.message}
        </Empty>
      </Page>
    )

  const data = pack.data
  const titles = new Map(data.playbooks.map((item) => [item.name, item.title ?? item.name]))
  const titleOf = (playbook: string) => titles.get(playbook) ?? playbook
  const save = (body: Schemas['PackPatch']) => patch.mutateAsync(body)
  const pick = (next: string) =>
    void navigate({
      to: '/packs/$name',
      params: { name },
      search: next === 'tools' ? {} : { tab: next as PackTab },
      replace: true,
    })
  return (
    <Page>
      <EntityHeader
        crumbs={[
          { label: 'Packs', to: '/packs' },
          { label: data.name, to: `/packs/${data.name}` },
        ]}
        title={<em>{data.title}</em>}
        actions={
          <>
            <Button variant="muted" onClick={() => setEditing(true)}>
              <IconPencil /> Edit
            </Button>
            <GiveAccess pack={data} />
          </>
        }
        meta={
          <>
            <UpstreamChips ids={data.upstreams} />
            <span>{holdsLine(data.counts)}</span>
            {data.flags ? (
              <span className="flex items-center gap-1 text-foreground">
                <IconAlertTriangle className="size-4 text-warn" /> {data.flags} wording{data.flags === 1 ? '' : 's'} to
                recheck
              </span>
            ) : null}
          </>
        }
      >
        {data.description || 'No description yet: its agents read it first, so say what the pack is for.'}
      </EntityHeader>
      <EntityTabs
        active={tab}
        onPick={pick}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'tools', label: 'Tools', count: data.tools.length, dot: Boolean(data.flags) },
          { id: 'playbooks', label: 'Playbooks & manuals', count: data.playbooks.length + data.manuals.length },
          { id: 'keys', label: 'Keys', count: data.keys },
          { id: 'activity', label: 'Activity' },
        ]}
      />
      {patch.error ? <p className="text-sm text-error">{patch.error.message}</p> : null}

      {tab === 'overview' ? (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Section title="What its agents read first">
            <Briefing pack={data} />
          </Section>
          <aside className="flex min-w-0 flex-col gap-8">
            <Section title={`Keys · ${data.keys}`}>
              <Keys pack={data} />
            </Section>
            <Section title="Remove">
              <div className="flex flex-col gap-3 border border-border bg-card p-4 text-sm text-muted-foreground">
                {data.keys
                  ? `Revoke its ${data.keys === 1 ? 'key' : `${data.keys} keys`} first: a key locked to a removed pack would reach nothing.`
                  : 'The tools stay where they are; only the pack and its wording go.'}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="danger" className="self-start" disabled={Boolean(data.keys)}>
                      Remove {data.title}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove {data.title}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Its {data.tools.length} tools stay in Yardhand; the pack, its playbook list and its wording go.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep it</AlertDialogCancel>
                      <AlertDialogAction onClick={() => remove.mutate()}>Remove</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                {remove.error ? <p className="text-error">{remove.error.message}</p> : null}
              </div>
            </Section>
          </aside>
        </div>
      ) : tab === 'tools' ? (
        <PackTools pack={data} titleOf={titleOf} onPatch={save} />
      ) : tab === 'playbooks' ? (
        <div className="flex flex-col gap-8">
          <Section
            title={`Playbooks · ${data.playbooks.length}`}
            aside={
              <Button size="sm" variant="ghost" onClick={() => setAddingPlaybook(true)}>
                <IconPlus /> Add a playbook
              </Button>
            }
          >
            <div className="border border-border bg-card [&_li:last-child]:border-b-0">
              <ItemList
                items={data.playbooks}
                empty="No playbooks yet. A playbook brings the tools it uses."
                onRemove={(item) => void save({ remove: { playbooks: [item] } })}
                link={(item) => (
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">{item.title ?? item.name}</span>
                    <Mono className="text-xs text-muted-foreground">{item.name}</Mono>
                  </span>
                )}
              />
            </div>
          </Section>
          <Section title={`Manuals · ${data.manuals.length}`}>
            <div className="border border-border bg-card [&_li:last-child]:border-b-0">
              <ItemList
                items={data.manuals}
                empty="No manuals. Adding a playbook offers its server's manual."
                onRemove={(item) => void save({ remove: { manuals: [item] } })}
                link={(item) =>
                  item.upstream ? (
                    <Link
                      to="/connections/$id"
                      params={{ id: item.upstream }}
                      search={{ tab: 'manual' }}
                      className="text-sm font-medium hover:text-primary"
                    >
                      {item.title ?? item.name}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium">{item.name}</span>
                  )
                }
              />
            </div>
          </Section>
        </div>
      ) : tab === 'keys' ? (
        <Keys pack={data} />
      ) : (
        <EntityActivity filter={{ pack: data.name }} clientIds={data.keyList.map((key) => key.id)} />
      )}

      <EditPack pack={data} open={editing} onOpenChange={setEditing} onSave={save} />
      <AddPlaybook pack={data} open={addingPlaybook} onOpenChange={setAddingPlaybook} onAdd={save} />
    </Page>
  )
}
