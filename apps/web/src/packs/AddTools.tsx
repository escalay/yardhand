/**
 * Adding tools to a pack by hand. Before any search: tools suggested from what the pack is for, then every tool by
 * connection (with "add all"); a Composio connection's tools by app, then by what they do (reads, changes, deletes).
 * While searching: best match first, the same search agents use. Chosen tools wait in a tray at the foot until added;
 * tools already in the pack show as such. Composio tools go in on the account picked for their app (by its label),
 * fixed so the pack's keys never see or change it, under a readable name made from the account and the tool.
 */
import { IconCheck, IconSearch, IconSparkles, IconX } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type Schemas, type ToolCard, unwrap } from '@/api/client'
import { shortTitleOf } from '@/connections/connections.rules'
import { upstreamsQuery } from '@/connections/queries'
import { toolsQuery } from '@/tools/queries'
import { Mono } from '@/ui/Code'
import { cn } from '@/ui/cn'
import { Illustration } from '@/ui/Illustration'
import { Button } from '@/ui/shadcn/button'
import { Checkbox } from '@/ui/shadcn/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/shadcn/dialog'
import { Input } from '@/ui/shadcn/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/shadcn/select'
import { Skeleton } from '@/ui/shadcn/skeleton'
import {
  accountAlias,
  addLabel,
  byConnection,
  EFFECTS,
  effectOf,
  freeAlias,
  lineOf,
  packQueryOf,
  suggestionsFor,
  toolkitOf,
} from './packs.rules'

type Pack = Schemas['Pack']
type Account = Schemas['UpstreamAccount']
/** A tool to add: its own name, and for a Composio tool the account it runs on and the pack's name for it. */
export type ToolDraft = { name: string; alias?: string; fixed?: Record<string, unknown> }

const ToolOption = ({
  tool,
  inPack,
  checked,
  suggested,
  onToggle,
}: {
  tool: ToolCard
  inPack: boolean
  checked: boolean
  suggested?: boolean
  onToggle: (on: boolean) => void
}) => (
  <li>
    <label
      className={cn(
        'flex cursor-pointer gap-3 border-b border-border px-5 py-3 transition-colors hover:bg-muted',
        checked && !inPack && 'bg-mist/60 hover:bg-mist',
        inPack && 'cursor-default hover:bg-transparent',
      )}
    >
      <Checkbox
        className="mt-0.5"
        disabled={inPack}
        checked={inPack || checked}
        onCheckedChange={(on) => onToggle(on === true)}
        aria-label={`Add ${tool.name}`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <Mono className={cn('text-[13px]', inPack && 'text-muted-foreground')}>{tool.name}</Mono>
          {tool.needsWrite ? <span className="text-xs text-muted-foreground">changes things</span> : null}
          {suggested ? <span className="text-xs text-primary">suggested</span> : null}
          {inPack ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <IconCheck className="size-3" /> in the pack
            </span>
          ) : null}
        </span>
        <span className="line-clamp-2 text-sm text-pretty text-muted-foreground">{lineOf(tool)}</span>
      </span>
    </label>
  </li>
)

const GroupHead = ({ label, count, action }: { label: React.ReactNode; count?: number; action?: React.ReactNode }) => (
  <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-muted/95 px-5 py-2 backdrop-blur">
    <span className="flex items-center gap-2 text-xs tracking-wide text-muted-foreground uppercase">
      {label}
      {count !== undefined ? <span className="font-mono normal-case">{count}</span> : null}
    </span>
    {action}
  </div>
)

export const AddTools = ({
  pack,
  open,
  onOpenChange,
  onAdd,
}: {
  pack: Pack
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (drafts: ToolDraft[]) => Promise<unknown>
}) => {
  const [words, setWords] = useState('')
  const [q, setQ] = useState('')
  const [upstream, setUpstream] = useState<string>()
  const [chosen, setChosen] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setQ(words.trim()), 250)
    return () => clearTimeout(timer)
  }, [words])

  const have = new Set(pack.tools.map((tool) => tool.tool))
  const [accountFor, setAccountFor] = useState<Record<string, string>>({})
  const all = useQuery({ ...toolsQuery({}), enabled: open })
  const found = useQuery({ ...toolsQuery({ q }), enabled: open && Boolean(q) })
  const forPack = packQueryOf(pack)
  const ranked = useQuery({ ...toolsQuery({ q: forPack }), enabled: open && !q && Boolean(pack.description) })
  const upstreams = useQuery({ ...upstreamsQuery, enabled: open })
  const composioIds = (upstreams.data?._embedded.upstreams ?? [])
    .filter((row) => row.kind === 'composio')
    .map((row) => row.id)
  const accounts = useQuery({
    queryKey: ['accounts', composioIds],
    enabled: open && composioIds.length > 0,
    staleTime: 60_000,
    queryFn: async () =>
      Object.fromEntries(
        await Promise.all(
          composioIds.map(async (id) => {
            const list = await unwrap(api.GET('/api/upstreams/{id}/accounts', { params: { path: { id } } }))
            return [id, list._embedded.accounts] as const
          }),
        ),
      ) as Record<string, Account[]>,
  })
  const isComposio = (tool: Pick<ToolCard, 'upstream'>) => composioIds.includes(tool.upstream)
  const toolkitsOf = (upstreamId: string) => [
    ...new Set((accounts.data?.[upstreamId] ?? []).map((account) => account.toolkit)),
  ]
  /** Where a Composio tool's account is chosen: one choice per connection and app. */
  const appKey = (tool: Pick<ToolCard, 'name' | 'upstream' | 'group'>) =>
    `${tool.upstream}:${tool.group?.key ?? toolkitOf(tool.name, toolkitsOf(tool.upstream))}`
  const accountsOf = (key: string) => {
    const [upstreamId = '', toolkit = ''] = key.split(':')
    return (accounts.data?.[upstreamId] ?? []).filter((account) => account.toolkit === toolkit)
  }
  const accountOf = (key: string) => {
    const options = accountsOf(key)
    return (
      options.find((account) => account.id === accountFor[key]) ??
      options.find((account) => account.isDefault) ??
      options[0]
    )
  }
  const titleOf = (id: string) => {
    const row = upstreams.data?._embedded.upstreams.find((entry) => entry.id === id)
    return row ? shortTitleOf(row.title) : id
  }

  const usable = (tool: ToolCard) => tool.access !== 'off'
  const base = (q ? (found.data?._embedded.tools ?? []) : (all.data?._embedded.tools ?? [])).filter(usable)
  const shown = base.filter((tool) => !upstream || tool.upstream === upstream)
  const counts = byConnection(base).map((group) => ({ upstream: group.upstream, count: group.tools.length }))
  const suggested = q || upstream ? [] : suggestionsFor(ranked.data?._embedded.tools ?? [], have)
  const suggestedNames = new Set(suggested.map((tool) => tool.name))
  const loading = q ? found.isPending : all.isPending

  const toggle = (name: string, on: boolean) =>
    setChosen((current) => (on ? [...new Set([...current, name])] : current.filter((entry) => entry !== name)))
  const reset = () => {
    setWords('')
    setQ('')
    setUpstream(undefined)
    setChosen([])
    setError(null)
  }
  const byName = new Map(base.map((tool) => [tool.name, tool]))
  const chosenApps = [
    ...new Set(
      chosen.flatMap((name) => {
        const tool = byName.get(name)
        return tool && isComposio(tool) ? [appKey(tool)] : []
      }),
    ),
  ]
  const draftsOf = (): ToolDraft[] => {
    const taken = new Set(pack.tools.map((tool) => tool.name))
    return chosen.map((name) => {
      const tool = byName.get(name)
      const account = tool && isComposio(tool) ? accountOf(appKey(tool)) : undefined
      if (!tool || !account) return { name }
      const alias = freeAlias(accountAlias(account.label, tool.title ?? name.split('.').pop() ?? name), taken)
      taken.add(alias)
      return { name, alias, fixed: { account: account.id } }
    })
  }
  const add = async () => {
    setAdding(true)
    setError(null)
    try {
      await onAdd(draftsOf())
      toast.success(`Added ${chosen.length === 1 ? chosen[0] : `${chosen.length} tools`} to ${pack.title}.`)
      reset()
      onOpenChange(false)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setAdding(false)
    }
  }

  /** A connection's tools by its groups (a Composio connection's are its apps), in the order they came. */
  const byGroup = (list: ToolCard[]) => {
    const groups = new Map<string, ToolCard[]>()
    for (const tool of list) {
      const title = tool.group?.title ?? 'Other'
      groups.set(title, [...(groups.get(title) ?? []), tool])
    }
    return [...groups].map(([title, tools]) => ({ title, tools }))
  }
  // A Composio tool can go in again, on another account
  const option = (tool: ToolCard, isSuggested = false) => (
    <ToolOption
      key={`${isSuggested ? 's' : 't'}:${tool.name}`}
      tool={tool}
      inPack={have.has(tool.name) && !isComposio(tool)}
      checked={chosen.includes(tool.name)}
      suggested={isSuggested || (!q && suggestedNames.has(tool.name))}
      onToggle={(on) => toggle(tool.name, on)}
    />
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="flex h-[min(46rem,92vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="gap-1 border-b border-border px-5 py-4">
          <DialogTitle>Add tools to {pack.title}</DialogTitle>
          <DialogDescription>
            Search by what a tool does, across every connection, the way agents do. Its keys will see only what you add.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 border-b border-border px-5 py-3">
          <div className="relative">
            <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint-foreground" />
            <Input
              autoFocus
              value={words}
              aria-label="Search tools by what they do"
              placeholder="look up an order, send an email, create a ticket…"
              className="pl-9"
              onChange={(event) => setWords(event.target.value)}
            />
            {q && found.isFetching ? (
              <span className="absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground">
                Searching…
              </span>
            ) : null}
          </div>
          {counts.length > 1 ? (
            <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {[{ upstream: undefined, count: base.length }, ...counts].map((chip) => (
                <button
                  key={chip.upstream ?? 'all'}
                  type="button"
                  aria-pressed={upstream === chip.upstream}
                  onClick={() => setUpstream(chip.upstream)}
                  className={cn(
                    'inline-flex h-7 shrink-0 items-center gap-1.5 border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground',
                    upstream === chip.upstream && 'border-primary/40 bg-mist text-foreground',
                  )}
                >
                  {chip.upstream ? titleOf(chip.upstream) : 'Every connection'}
                  <span className="font-mono text-[10px] text-faint-foreground">{chip.count}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex flex-col gap-2 p-5">
              <Skeleton className="h-14 rounded-none" />
              <Skeleton className="h-14 rounded-none" />
              <Skeleton className="h-14 rounded-none" />
            </div>
          ) : !shown.length ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <Illustration name="nothing-found" className="h-28 w-auto" />
              <p className="text-base">{q ? `No tool does “${q}” yet` : 'No tools here yet'}</p>
              <p className="max-w-md text-sm text-pretty text-muted-foreground">
                {q ? 'Try what it does rather than its name, like “look up an order”. Or ' : ''}
                <Link to="/connections/new" className="text-foreground underline underline-offset-4">
                  connect the server that has it
                </Link>
                {q ? '.' : ', then its tools show here.'}
              </p>
              {upstream ? (
                <Button variant="ghost" size="sm" onClick={() => setUpstream(undefined)}>
                  Look in every connection
                </Button>
              ) : null}
            </div>
          ) : q ? (
            <>
              <GroupHead label="Best match first" count={shown.length} />
              <ul>{shown.map((tool) => option(tool))}</ul>
            </>
          ) : (
            <>
              {suggested.length ? (
                <section>
                  <GroupHead
                    label={
                      <>
                        <IconSparkles className="size-3.5 text-primary" /> Suggested for what {pack.title} is for
                      </>
                    }
                  />
                  <ul>{suggested.map((tool) => option(tool, true))}</ul>
                </section>
              ) : null}
              {byConnection(shown).map((group) => {
                const addable = group.tools.filter((tool) => !have.has(tool.name)).map((tool) => tool.name)
                const allChosen = addable.length > 0 && addable.every((name) => chosen.includes(name))
                return (
                  <section key={group.upstream}>
                    <GroupHead
                      label={titleOf(group.upstream)}
                      count={group.tools.length}
                      action={
                        // A Composio app is picked tool by tool, each on an account: no add-all
                        isComposio(group.tools[0] ?? { upstream: '' }) ? undefined : addable.length ? (
                          <Button
                            variant="link"
                            size="xs"
                            onClick={() =>
                              setChosen((current) =>
                                allChosen
                                  ? current.filter((name) => !addable.includes(name))
                                  : [...new Set([...current, ...addable])],
                              )
                            }
                          >
                            {allChosen ? 'Clear these' : `Add all ${addable.length}`}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">all in the pack</span>
                        )
                      }
                    />
                    {byGroup(group.tools).length > 1 || isComposio(group.tools[0] ?? { upstream: '' }) ? (
                      byGroup(group.tools).map(({ title, tools }) =>
                        (isComposio(tools[0] ?? { upstream: '' }) ? EFFECTS : [null]).map((effect) => {
                          const listed = effect ? tools.filter((tool) => effectOf(tool) === effect.id) : tools
                          return listed.length ? (
                            <div key={`${title}:${effect?.id ?? 'all'}`}>
                              <div className="border-b border-border px-5 py-1.5 text-xs text-muted-foreground">
                                {title}
                                {effect ? (
                                  <>
                                    {' · '}
                                    <span className={effect.id === 'deletes' ? 'text-error' : ''}>{effect.label}</span>
                                  </>
                                ) : null}{' '}
                                <span className="font-mono text-[10px] text-faint-foreground">{listed.length}</span>
                              </div>
                              <ul>{listed.map((tool) => option(tool))}</ul>
                            </div>
                          ) : null
                        }),
                      )
                    ) : (
                      <ul>{group.tools.map((tool) => option(tool))}</ul>
                    )}
                  </section>
                )
              })}
            </>
          )}
        </div>

        {chosenApps.length ? (
          <div className="flex flex-col gap-2 border-t border-border bg-mist/40 px-5 py-3">
            {chosenApps.map((key) => {
              const options = accountsOf(key)
              const current = accountOf(key)
              return (
                <div key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="min-w-40">
                    <span className="font-medium">{key.split(':')[1]}</span> tools run on
                  </span>
                  {options.length ? (
                    <Select
                      value={current?.id ?? ''}
                      onValueChange={(id) => setAccountFor((was) => ({ ...was, [key]: id }))}
                    >
                      <SelectTrigger aria-label={`Account for ${key.split(':')[1]}`} className="w-full sm:w-96">
                        <SelectValue placeholder="Choose an account" />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            {account.label}
                            {account.status === 'ACTIVE' ? '' : ` (${account.status.toLowerCase()})`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-muted-foreground">
                      {accounts.isPending ? 'reading its accounts…' : 'its default account (none listed)'}
                    </span>
                  )}
                </div>
              )
            })}
            <p className="text-xs text-muted-foreground">
              Fixed in the pack: its keys never see or change the account. Each tool gets a name from the account, like{' '}
              <Mono className="text-xs">{draftsOf().find((draft) => draft.alias)?.alias ?? 'work_fetch_emails'}</Mono>.
              Rename it after under Name &amp; inputs.
            </p>
          </div>
        ) : null}
        <div className="flex flex-col gap-3 border-t border-border bg-card px-5 py-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {chosen.length ? (
              <>
                {chosen.slice(0, 5).map((name) => (
                  <span
                    key={name}
                    className="inline-flex h-7 max-w-56 items-center gap-1 border border-border bg-mist pl-2"
                  >
                    <Mono className="truncate text-xs">{name}</Mono>
                    <button
                      type="button"
                      aria-label={`Don't add ${name}`}
                      onClick={() => toggle(name, false)}
                      className="grid size-6 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
                    >
                      <IconX className="size-3" />
                    </button>
                  </span>
                ))}
                {chosen.length > 5 ? (
                  <span className="text-xs text-muted-foreground">and {chosen.length - 5} more</span>
                ) : null}
              </>
            ) : (
              <span className="text-sm text-muted-foreground">
                {pack.tools.length ? `${pack.tools.length} in the pack now.` : 'The pack is empty.'} Tick what its
                agents need.
              </span>
            )}
          </div>
          {error ? <p className="text-sm text-error">{error}</p> : null}
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!chosen.length || adding} onClick={() => void add()}>
              {adding ? 'Adding…' : addLabel(chosen.length)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
