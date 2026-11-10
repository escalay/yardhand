/**
 * Adding a playbook to a pack, with the tools it uses: those it names or calls by route are certain and checked;
 * those likely by meaning are offered for the owner to confirm; its server's manual comes along unless unticked.
 */
import { IconArrowLeft } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { Schemas } from '@/api/client'
import { Mono } from '@/ui/Code'
import { Button } from '@/ui/shadcn/button'
import { Checkbox } from '@/ui/shadcn/checkbox'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/ui/shadcn/command'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/shadcn/sheet'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { preselected, USE_LABEL } from './packs.rules'
import { allPlaybooksQuery, usesQuery } from './queries'

type Pack = Schemas['Pack']
type Playbook = Schemas['Playbook']

const Uses = ({
  pack,
  playbook,
  onBack,
  onAdd,
}: {
  pack: Pack
  playbook: Playbook
  onBack: () => void
  onAdd: (body: Schemas['PackPatch']) => Promise<unknown>
}) => {
  const uses = useQuery(usesQuery(playbook.name, pack.name))
  const [chosen, setChosen] = useState<string[] | null>(null)
  const [withManual, setWithManual] = useState(true)
  const [busy, setBusy] = useState(false)
  const rows = uses.data?.uses ?? []
  const picked = chosen ?? preselected(rows)
  const manual = uses.data?.manual ?? null
  const manualIn = manual ? pack.manuals.some((item) => item.name === manual) : true
  const groups = [
    {
      title: 'Certain: the playbook names them or calls their route',
      rows: rows.filter((u) => u.reason !== 'meaning'),
    },
    { title: 'Likely, by meaning: tick the ones it needs', rows: rows.filter((u) => u.reason === 'meaning') },
  ].filter((group) => group.rows.length)
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-border px-5 py-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
        >
          <IconArrowLeft className="size-3.5" /> Another playbook
        </button>
        <p className="text-sm font-medium">{playbook.title}</p>
        <p className="line-clamp-3 text-sm text-muted-foreground">{playbook.description}</p>
      </div>
      {uses.isPending ? (
        <div className="flex flex-col gap-2 p-5">
          <Skeleton className="h-12 rounded-none" />
          <Skeleton className="h-12 rounded-none" />
        </div>
      ) : uses.error ? (
        <p className="p-5 text-sm text-error">{uses.error.message}</p>
      ) : (
        <div className="flex flex-1 flex-col overflow-y-auto">
          {uses.data && !uses.data.textRead ? (
            <p className="border-b border-border bg-warn-soft px-5 py-3 text-sm">
              Its text couldn't be read just now ({uses.data.upstream} didn't answer), so only guesses by meaning show.
            </p>
          ) : null}
          {groups.length ? null : (
            <p className="px-5 py-4 text-sm text-muted-foreground">It names no tools: add the playbook on its own.</p>
          )}
          {groups.map((group) => (
            <section key={group.title} className="flex flex-col">
              <h3 className="border-b border-border bg-muted px-5 py-2 text-xs tracking-wide text-muted-foreground uppercase">
                {group.title}
              </h3>
              <ul>
                {group.rows.map((use) => (
                  <li key={use.tool} className="border-b border-border">
                    <label className="flex cursor-pointer gap-3 px-5 py-3 has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
                      <Checkbox
                        className="mt-0.5"
                        disabled={use.inPack}
                        checked={use.inPack || picked.includes(use.tool)}
                        onCheckedChange={(checked) =>
                          setChosen(
                            checked === true ? [...picked, use.tool] : picked.filter((name) => name !== use.tool),
                          )
                        }
                      />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <Mono className="text-[13px]">{use.tool}</Mono>
                          <span className="text-xs text-muted-foreground">
                            {use.inPack ? 'Already in' : USE_LABEL[use.reason]}
                          </span>
                        </span>
                        <span className="line-clamp-2 text-sm text-muted-foreground">{use.summary}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {manual && !manualIn ? (
            <label className="flex cursor-pointer gap-3 border-b border-border px-5 py-3">
              <Checkbox
                className="mt-0.5"
                checked={withManual}
                onCheckedChange={(checked) => setWithManual(checked === true)}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">And {uses.data?.upstream}’s manual</span>
                <span className="text-sm text-muted-foreground">
                  How its server wants its tools used; agents read it once.
                </span>
              </span>
            </label>
          ) : null}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
        <span className="text-sm text-muted-foreground">
          {picked.length ? `${picked.length} tool${picked.length === 1 ? '' : 's'} with it` : 'The playbook alone'}
        </span>
        <Button
          variant="primary"
          disabled={uses.isPending || busy}
          onClick={() => {
            setBusy(true)
            const byTool = new Map(rows.map((use) => [use.tool, use]))
            void onAdd({
              add: {
                playbooks: [playbook.name],
                tools: picked.map((name) => ({
                  name,
                  reason: byTool.get(name)?.reason ?? 'picked',
                  via: playbook.name,
                })),
                ...(manual && !manualIn && withManual ? { manuals: [manual] } : {}),
              },
            }).finally(() => setBusy(false))
          }}
        >
          Add to {pack.title}
        </Button>
      </div>
    </div>
  )
}

export const AddPlaybook = ({
  pack,
  open,
  onOpenChange,
  onAdd,
}: {
  pack: Pack
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (body: Schemas['PackPatch']) => Promise<unknown>
}) => {
  const playbooks = useQuery({ ...allPlaybooksQuery, enabled: open })
  const [playbook, setPlaybook] = useState<Playbook | null>(null)
  const have = new Set(pack.playbooks.map((item) => item.name))
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setPlaybook(null)
        onOpenChange(next)
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle>Add a playbook</SheetTitle>
          <SheetDescription>The tools it uses come with it: you see which, and why.</SheetDescription>
        </SheetHeader>
        {playbook ? (
          <Uses
            pack={pack}
            playbook={playbook}
            onBack={() => setPlaybook(null)}
            onAdd={(body) =>
              onAdd(body).then(() => {
                setPlaybook(null)
                onOpenChange(false)
              })
            }
          />
        ) : (
          <Command className="flex-1">
            <CommandInput placeholder="Search playbooks…" autoFocus />
            <CommandList className="max-h-none flex-1">
              <CommandEmpty>{playbooks.isPending ? 'Loading…' : 'No playbook matches.'}</CommandEmpty>
              <CommandGroup>
                {(playbooks.data?._embedded.playbooks ?? [])
                  .filter((item) => !have.has(item.name))
                  .map((item) => (
                    <CommandItem
                      key={item.name}
                      value={`${item.title} ${item.name} ${item.description}`}
                      onSelect={() => setPlaybook(item)}
                      className="flex flex-col items-start gap-0.5 px-3 py-2"
                    >
                      <span>{item.title}</span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">{item.description}</span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </SheetContent>
    </Sheet>
  )
}
