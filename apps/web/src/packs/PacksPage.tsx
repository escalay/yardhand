/**
 * Packs: the board of curated kits. Each card says what the pack is for, which servers it draws on, what it holds and
 * how many keys are locked to it; a pack starts empty or from a playbook, which brings in the tools it uses.
 */
import { IconAlertTriangle, IconKey, IconPlus } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { api, type Schemas, unwrap } from '@/api/client'
import { cn } from '@/ui/cn'
import { Empty } from '@/ui/Empty'
import { Field } from '@/ui/Field'
import { plural } from '@/ui/format'
import { Page, PageHeader } from '@/ui/Page'
import { Button } from '@/ui/shadcn/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/ui/shadcn/command'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/shadcn/dialog'
import { Input } from '@/ui/shadcn/input'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { Textarea } from '@/ui/shadcn/textarea'
import { holdsLine, isPackName, slugOf } from './packs.rules'
import { allPlaybooksQuery, packsQuery } from './queries'

type PackCard = Schemas['PackCard']

export const UpstreamChips = ({ ids, className }: { ids: string[]; className?: string }) => (
  <span className={cn('flex flex-wrap gap-1', className)}>
    {ids.map((id) => (
      <span
        key={id}
        className="border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
      >
        {id}
      </span>
    ))}
  </span>
)

const Card = ({ pack }: { pack: PackCard }) => (
  <Link
    to="/packs/$name"
    params={{ name: pack.name }}
    className="group flex min-h-56 flex-col gap-4 border border-border bg-card p-5 transition-colors hover:border-primary/40 hover:bg-mist/40"
  >
    <div className="flex items-start justify-between gap-3">
      <UpstreamChips ids={pack.upstreams} />
      {pack.flags ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-warn" title="Wording to recheck">
          <IconAlertTriangle className="size-3.5" /> {pack.flags}
        </span>
      ) : null}
    </div>
    <div className="flex flex-1 flex-col gap-2">
      <h2 className="text-2xl tracking-tight text-balance group-hover:text-primary">{pack.title}</h2>
      <p className="line-clamp-3 text-sm text-pretty text-muted-foreground">
        {pack.description || 'No description yet: agents read it first.'}
      </p>
    </div>
    <div className="flex items-end justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
      <span>{holdsLine(pack.counts)}</span>
      <span className="flex items-center gap-1 font-mono">
        <IconKey className="size-3.5" />
        {pack.keys ? plural(pack.keys, 'key') : 'No keys'}
      </span>
    </div>
  </Link>
)

/** Name a new pack, empty or started from one of the playbooks the servers offer. */
const NewPack = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const navigate = useNavigate()
  const queries = useQueryClient()
  const playbooks = useQuery({ ...allPlaybooksQuery, enabled: open })
  const [title, setTitle] = useState('')
  const [name, setName] = useState('')
  const [named, setNamed] = useState(false)
  const [description, setDescription] = useState('')
  const [playbook, setPlaybook] = useState<Schemas['Playbook'] | null>(null)
  const finalName = named ? name : slugOf(title)
  const make = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/packs', {
          body: {
            name: finalName,
            title: title.trim(),
            description: description.trim(),
            ...(playbook ? { playbook: playbook.name } : {}),
          },
        }),
      ),
    onSuccess: (pack) => {
      void queries.invalidateQueries({ queryKey: ['packs'] })
      onOpenChange(false)
      void navigate({ to: '/packs/$name', params: { name: pack.name } })
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle>A new pack</DialogTitle>
          <DialogDescription>
            A kit for one kind of work. Start from a playbook and the tools it uses come with it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5 px-6 py-5"
          onSubmit={(event) => {
            event.preventDefault()
            make.mutate()
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
            <Field label="Title">
              {(id) => (
                <Input
                  id={id}
                  required
                  autoFocus
                  maxLength={80}
                  value={title}
                  placeholder="Design"
                  onChange={(event) => setTitle(event.target.value)}
                />
              )}
            </Field>
            <Field label="Name" hint="In URLs and keys.">
              {(id) => (
                <Input
                  id={id}
                  className="font-mono"
                  value={finalName}
                  onChange={(event) => {
                    setNamed(true)
                    setName(event.target.value.toLowerCase())
                  }}
                />
              )}
            </Field>
          </div>
          <Field
            label="What it is for"
            hint="Agents with a key to this pack read this first, as the server’s instructions."
          >
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                maxLength={4000}
                value={description}
                placeholder="Support work: look up an order, reply to a customer, file a ticket."
                onChange={(event) => setDescription(event.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Start from a playbook (optional)</span>
            {playbook ? (
              <div className="flex items-start justify-between gap-3 border border-primary/40 bg-mist/50 p-3">
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{playbook.title}</span>
                  <span className="line-clamp-2 text-sm text-muted-foreground">{playbook.description}</span>
                </span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setPlaybook(null)}>
                  Change
                </Button>
              </div>
            ) : (
              <Command className="border border-border">
                <CommandInput placeholder="Search playbooks: refund, triage, handover…" />
                <CommandList className="max-h-56">
                  <CommandEmpty>{playbooks.isPending ? 'Loading…' : 'No playbook matches.'}</CommandEmpty>
                  <CommandGroup>
                    {(playbooks.data?._embedded.playbooks ?? []).map((item) => (
                      <CommandItem
                        key={item.name}
                        value={`${item.title} ${item.name} ${item.description}`}
                        onSelect={() => {
                          setPlaybook(item)
                          if (!title.trim()) setTitle(item.title.replace(/^.*?·\s*/, ''))
                        }}
                        className="flex flex-col items-start gap-0.5"
                      >
                        <span>{item.title}</span>
                        <span className="line-clamp-1 text-xs text-muted-foreground">{item.description}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            )}
          </div>
          {make.error ? <p className="text-sm text-error">{make.error.message}</p> : null}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!title.trim() || !isPackName(finalName) || make.isPending}
            >
              {make.isPending ? 'Making…' : playbook ? 'Make it from the playbook' : 'Make the pack'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export const PacksPage = () => {
  const packs = useQuery(packsQuery)
  const [making, setMaking] = useState(false)
  const rows = packs.data?._embedded.packs ?? []
  const action = (
    <Button variant="primary" onClick={() => setMaking(true)}>
      <IconPlus /> New pack
    </Button>
  )
  return (
    <Page>
      <PageHeader
        label="Packs"
        title={
          <>
            Kits for one kind of <em>work</em>
          </>
        }
        actions={rows.length ? action : null}
      >
        Tools from any connection, the playbooks and manuals that go with them, in your own words. A key locked to a
        pack sees nothing else.
      </PageHeader>
      {packs.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-56 rounded-none" />
          <Skeleton className="h-56 rounded-none" />
        </div>
      ) : packs.error ? (
        <Empty illustration="storm" title="Packs didn't load">
          {packs.error.message}
        </Empty>
      ) : rows.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((pack) => (
            <Card key={pack.name} pack={pack} />
          ))}
          <button
            type="button"
            onClick={() => setMaking(true)}
            className="flex min-h-56 flex-col items-center justify-center gap-2 border border-dashed border-input text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <IconPlus className="size-5" /> New pack
          </button>
        </div>
      ) : (
        <Empty illustration="tools" title="No packs yet" action={action}>
          Make one for design work, or for one client: an agent with its key gets exactly those tools, listed directly,
          in the words you choose. Start from a playbook and the tools it uses come with it.
        </Empty>
      )}
      <NewPack open={making} onOpenChange={setMaking} />
    </Page>
  )
}
