/**
 * One pack: its tools (why each is in, the pack's wording, flags when an upstream moved on), its playbooks and
 * manuals, and the people it is shared with, with one more from the Share sheet. The Overview checks it as it is
 * built: the steps of setting it up, its address with setup per app, a search of it as its keys get it, and what its
 * agents read first.
 */
import { IconAlertTriangle, IconPencil, IconPlus, IconSearch, IconUserPlus, IconX } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { EntityActivity } from '@/activity/EntityActivity'
import { api, type Schemas, unwrap } from '@/api/client'
import { useScope } from '@/shell/scope'
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
import { AddressCard } from './AddressCard'
import { Checklist } from './Checklist'
import { UpstreamChips } from './PacksPage'
import { PackTools } from './PackTools'
import { People } from './People'
import { accessOf, endsOf, holdsLine, isPackName, nameProblem, type PackTab, renameNote } from './packs.rules'
import { packQuery, packsQuery } from './queries'
import { ShareSheet } from './ShareSheet'
import { TRY_ID, TryIt } from './TryIt'

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
  const [name, setName] = useState(pack.name)
  const [title, setTitle] = useState(pack.title)
  const [description, setDescription] = useState(pack.description)
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Opened again, by whichever button: it starts from the pack, not from what was typed or refused last time
  const [shown, setShown] = useState(open)
  if (open !== shown) {
    setShown(open)
    if (open) {
      setName(pack.name)
      setTitle(pack.title)
      setDescription(pack.description)
      setProblem(null)
    }
  }
  const renamed = name !== pack.name
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{pack.title}</DialogTitle>
          <DialogDescription>Its keys read the description first, as the server's instructions.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setProblem(null)
            setSaving(true)
            void onSave({ ...(renamed ? { name } : {}), title: title.trim(), description: description.trim() })
              .then(
                () => onOpenChange(false),
                (error: Error) => setProblem(error.message),
              )
              .finally(() => setSaving(false))
          }}
        >
          <Field
            label="Name"
            hint={
              <>
                Its address is <Mono>/p/{name || '…'}</Mono>.{renamed ? ` ${renameNote(pack.keys, pack.name)}` : null}
              </>
            }
            error={nameProblem(name)}
          >
            {(id) => (
              <Input
                id={id}
                required
                className="font-mono"
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
              />
            )}
          </Field>
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
          {problem ? (
            <p role="alert" className="text-sm text-error">
              {problem}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!title.trim() || !isPackName(name) || saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Roughly what an agent with this pack's key is told on connecting: the pack's words, then how to work it. */
const Briefing = ({ pack }: { pack: Pack }) => {
  const listed = pack.tools.filter((tool) => tool.live)
  return (
    <div className="flex flex-col gap-3 border border-border bg-inverse p-5 font-mono text-[12px] leading-relaxed text-inverse-foreground/85">
      <p className="text-inverse-foreground">
        {pack.title}: {pack.description || '…'}
      </p>
      {listed.length ? (
        <p>
          Every tool of this pack is listed here: call one as it is. search_tools finds one by what you want to do,
          describe_tool shows its full description and input schema, and call_tool runs any of them by name.
        </p>
      ) : (
        <p>This pack holds no tools this key can use.</p>
      )}
      {pack.playbooks.length ? <p>Playbooks: {pack.playbooks.map((item) => item.name).join(', ')}.</p> : null}
      {listed.length ? (
        <div>
          <p>Listed here:</p>
          {listed.slice(0, 8).map((tool) => (
            <p key={tool.name} className="truncate">
              - {tool.name}: {tool.description.split('\n')[0]}
            </p>
          ))}
          {listed.length > 8 ? <p>- … {listed.length - 8} more</p> : null}
        </div>
      ) : null}
    </div>
  )
}

/** Who has the pack, in short, beside its Overview: the People tab has the rest. */
const Shared = ({ pack, onShare }: { pack: Pack; onShare: () => void }) => (
  <div className="flex flex-col border border-border bg-card">
    {pack.keyList.length ? (
      <ul>
        {pack.keyList.map((key) => (
          <li key={key.id} className="border-b border-border px-4 py-3">
            <Link to="/agents/$id" params={{ id: key.id }} className="flex flex-col hover:text-primary">
              <span className="text-sm font-medium">{key.name}</span>
              <span className="text-xs text-muted-foreground first-letter:uppercase">
                {accessOf(key.scope)} · {key.expiresAt ? `ends ${endsOf(key).text}` : 'until revoked'}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    ) : (
      <p className="border-b border-border px-4 py-4 text-sm text-muted-foreground">Nobody has access yet.</p>
    )}
    {pack.ended ? (
      <p className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
        {pack.ended} ended:{' '}
        <Link
          to="/packs/$name"
          params={{ name: pack.name }}
          search={{ tab: 'people' }}
          className="rounded-xs text-foreground underline underline-offset-4 hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          extend under People
        </Link>
      </p>
    ) : null}
    <div className="p-3">
      <Button variant="ghost" size="sm" disabled={!pack.tools.length} onClick={onShare}>
        <IconUserPlus /> Share
      </Button>
    </div>
  </div>
)

export const PackPage = ({
  name,
  tab = 'tools',
  add,
  share,
}: {
  name: string
  tab?: PackTab
  add?: boolean
  share?: boolean
}) => {
  const queries = useQueryClient()
  const navigate = useNavigate()
  const pack = useQuery(packQuery(name))
  const { scope, setScope } = useScope()
  const [editing, setEditing] = useState(false)
  const [addingPlaybook, setAddingPlaybook] = useState(false)
  const patch = useMutation({
    mutationFn: (body: Schemas['PackPatch']) =>
      unwrap(api.PATCH('/api/packs/{name}', { params: { path: { name } }, body })),
    onSuccess: async (data) => {
      queries.setQueryData(packQuery(data.name).queryKey, data)
      if (data.name !== name) {
        // The saved scope is kept by name and dropped when no pack has it: the scope and the list it is checked
        // against take the new name together
        queries.setQueryData(
          packsQuery.queryKey,
          (list) =>
            list && {
              ...list,
              _embedded: {
                packs: list._embedded.packs.map((card) =>
                  card.name === name ? { ...card, name: data.name, title: data.title } : card,
                ),
              },
            },
        )
        if (scope.kind === 'pack' && scope.name === name) setScope({ kind: 'pack', name: data.name, title: data.title })
        // The page moves first: asked again under its old name, the pack is a 404
        await navigate({
          to: '/packs/$name',
          params: { name: data.name },
          search: tab === 'tools' ? {} : { tab },
          replace: true,
        })
        queries.removeQueries({ queryKey: ['pack', name] })
        queries.removeQueries({ queryKey: ['people', name] })
      }
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
  // The sheet opens over the part the owner is on, and closing it leaves them there
  const sharing = (open: boolean) =>
    void navigate({
      to: '/packs/$name',
      params: { name },
      search: { ...(tab === 'tools' ? {} : { tab }), ...(open ? { share: true as const } : {}) },
      replace: true,
      resetScroll: false,
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
            <Button asChild variant="muted">
              <Link to="/packs/$name" params={{ name }} search={{ tab: 'overview' }} hash={TRY_ID}>
                <IconSearch /> Try it
              </Link>
            </Button>
            <Button variant="muted" onClick={() => setEditing(true)}>
              <IconPencil /> Edit
            </Button>
            <Button
              variant="primary"
              disabled={!data.tools.length}
              title={data.tools.length ? undefined : 'Add tools first: a key to an empty pack would reach nothing.'}
              onClick={() => sharing(true)}
            >
              <IconUserPlus /> Share
            </Button>
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
          // Everyone People lists: who has it, and whose access ended and can be extended
          { id: 'people', label: 'People', count: data.keys + data.ended, dot: Boolean(data.ending) },
          { id: 'activity', label: 'Activity' },
        ]}
      />
      {patch.error && !editing ? <p className="text-sm text-error">{patch.error.message}</p> : null}

      {tab === 'overview' ? (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex min-w-0 flex-col gap-8">
            <Checklist pack={data} onEdit={() => setEditing(true)} />
            <AddressCard pack={data} />
            <TryIt pack={data} />
            <Section title="What its agents read first">
              <Briefing pack={data} />
            </Section>
          </div>
          <aside className="flex min-w-0 flex-col gap-8">
            <Section title={`People · ${data.keys}`}>
              <Shared pack={data} onShare={() => sharing(true)} />
            </Section>
            <Section title="Remove">
              <div className="flex flex-col gap-3 border border-border bg-card p-4 text-sm text-muted-foreground">
                {data.keys
                  ? `End access for its ${data.keys === 1 ? 'person' : `${data.keys} people`} first: a key locked to a removed pack would reach nothing.`
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
        <PackTools
          pack={data}
          titleOf={titleOf}
          onPatch={save}
          adding={Boolean(add)}
          onAdding={(open) =>
            void navigate({
              to: '/packs/$name',
              params: { name },
              search: open ? { add: true } : {},
              replace: true,
              // The button is at the foot of the list: the page stays where it is behind the dialog
              resetScroll: false,
            })
          }
        />
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
      ) : tab === 'people' ? (
        <People pack={data} onShare={() => sharing(true)} />
      ) : (
        <EntityActivity filter={{ pack: data.name }} clientIds={data.keyList.map((key) => key.id)} />
      )}

      <EditPack
        pack={data}
        open={editing}
        onOpenChange={(open) => {
          // A save the dialog refused was said in the dialog: it is not left on the page behind it
          if (!open) patch.reset()
          setEditing(open)
        }}
        onSave={save}
      />
      <AddPlaybook pack={data} open={addingPlaybook} onOpenChange={setAddingPlaybook} onAdd={save} />
      <ShareSheet pack={data} open={Boolean(share)} onOpenChange={sharing} />
    </Page>
  )
}
