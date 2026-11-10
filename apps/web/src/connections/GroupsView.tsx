/**
 * A connection's tools by group, each group with a switch that holds for tools the server adds later, and its tools
 * by effect (reads, changes things, deletes) with a switch each in the header. Inside a group the owner turns one
 * tool back on, renames the group, or moves a tool to another group. A Composio connection's groups are its apps; an
 * app switched off isn't fetched at all.
 */
import { IconChevronRight, IconPlus } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { api, type Schemas, type ToolCard, unwrap } from '@/api/client'
import { Mono } from '@/ui/Code'
import { cn } from '@/ui/cn'
import { Button } from '@/ui/shadcn/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/shadcn/collapsible'
import { Input } from '@/ui/shadcn/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/shadcn/select'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { Switch } from '@/ui/shadcn/switch'
import { EFFECT_LABEL, groupedByLine, groupLine, onAccessOf, toolStateOf, yoursLine } from './groups.rules'
import { RegroupCard } from './Regroup'

type Groups = Schemas['ToolGroups']
type Group = Schemas['ToolGroup']

export const groupsQuery = (id: string) => ({
  queryKey: ['groups', id],
  queryFn: () => unwrap(api.GET('/api/upstreams/{id}/groups', { params: { path: { id } } })),
})

const useRefresh = (id: string) => {
  const queries = useQueryClient()
  return (view?: Groups) => {
    if (view) queries.setQueryData(['groups', id], view)
    for (const key of [['groups', id], ['tools'], ['tool'], ['upstream', id], ['packs'], ['pack']])
      void queries.invalidateQueries({ queryKey: key })
  }
}

const ToolLine = ({ tool, groups, upstream }: { tool: ToolCard; groups: Group[]; upstream: string }) => {
  const refresh = useRefresh(upstream)
  const state = toolStateOf(tool)
  const access = useMutation({
    mutationFn: (value: 'read' | 'write' | 'off' | null) =>
      unwrap(api.PATCH('/api/tools/{name}', { params: { path: { name: tool.name } }, body: { access: value } })),
    onSuccess: () => refresh(),
    onError: (error) => toast.error(error.message),
  })
  const move = useMutation({
    mutationFn: (group: string) =>
      unwrap(api.PUT('/api/tools/{name}/group', { params: { path: { name: tool.name } }, body: { group } })),
    onSuccess: (view) => refresh(view),
    onError: (error) => toast.error(error.message),
  })
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2.5 text-sm">
      <Link
        to="/tools/$name"
        params={{ name: tool.name }}
        className={cn('min-w-0 flex-1 truncate hover:text-primary', !state.on && 'text-muted-foreground')}
      >
        <Mono className="text-[13px]">{tool.name.slice(upstream.length + 1)}</Mono>
        <span className="ml-3 text-muted-foreground">{tool.summary}</span>
      </Link>
      <span className={cn('text-xs', state.on ? 'text-muted-foreground' : 'text-warn')}>{state.text}</span>
      {state.action === 'turn-on' ? (
        <Button size="xs" variant="ghost" onClick={() => access.mutate(onAccessOf(tool))}>
          Turn on
        </Button>
      ) : state.action === 'follow' ? (
        <Button size="xs" variant="ghost" onClick={() => access.mutate(null)}>
          Follow its group
        </Button>
      ) : (
        <Button size="xs" variant="ghost" onClick={() => access.mutate('off')}>
          Turn off
        </Button>
      )}
      {groups.length > 1 ? (
        <Select value={tool.group?.key ?? ''} onValueChange={(group) => move.mutate(group)}>
          <SelectTrigger size="sm" aria-label={`Move ${tool.name} to another group`} className="h-7 w-36 text-xs">
            <SelectValue placeholder="Move to…" />
          </SelectTrigger>
          <SelectContent>
            {groups.map((group) => (
              <SelectItem key={group.key} value={group.key}>
                {group.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </li>
  )
}

const GroupRow = ({
  group,
  groups,
  tools,
  upstream,
}: {
  group: Group
  groups: Group[]
  tools: ToolCard[]
  upstream: string
}) => {
  const refresh = useRefresh(upstream)
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState<string | null>(null)
  const change = useMutation({
    mutationFn: (body: { off?: boolean; title?: string }) =>
      unwrap(
        api.PATCH('/api/upstreams/{id}/groups/{key}', { params: { path: { id: upstream, key: group.key } }, body }),
      ),
    onSuccess: (view, body) => {
      refresh(view)
      if (body.off !== undefined)
        toast.success(
          group.app
            ? body.off
              ? `${group.title} is off: its tools aren’t fetched.`
              : `${group.title} is on: its tools were fetched.`
            : body.off
              ? `${group.title} is off for every agent, and new tools filed in it start off.`
              : `${group.title} is on again.`,
        )
    },
    onError: (error) => toast.error(error.message),
  })
  // The gateway refuses a group that is off with tools in it, and says why
  const remove = useMutation({
    mutationFn: () =>
      unwrap(api.DELETE('/api/upstreams/{id}/groups/{key}', { params: { path: { id: upstream, key: group.key } } })),
    onSuccess: (view) => {
      refresh(view)
      toast.success(
        group.tools
          ? `${group.title} is gone: ${group.tools === 1 ? 'its tool is' : `its ${group.tools} tools are`} in Other.`
          : `${group.title} is gone.`,
      )
    },
    onError: (error) => toast.error(error.message),
  })
  const members = tools.filter((tool) => tool.group?.key === group.key)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-border last:border-b-0">
      <div className={cn('flex flex-wrap items-center gap-3 px-4 py-3', group.off && 'bg-muted/50')}>
        <CollapsibleTrigger
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          disabled={!members.length}
          aria-label={`Show the tools in ${group.title}`}
        >
          <IconChevronRight
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          />
          {group.app?.logo ? <img src={group.app.logo} alt="" className="size-4 shrink-0" /> : null}
          {naming === null ? (
            <span className={cn('font-medium', group.off && 'text-muted-foreground')}>{group.title}</span>
          ) : null}
          <span className="truncate text-xs text-muted-foreground">
            {group.app && !group.app.fetched
              ? `${group.app.available ?? '?'} tools in Composio · not fetched`
              : groupLine(group)}
            {group.offTools && !group.off ? ` · ${group.offTools} off` : ''}
          </span>
        </CollapsibleTrigger>
        {naming !== null ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (naming.trim()) change.mutate({ title: naming.trim() }, { onSuccess: () => setNaming(null) })
            }}
          >
            <Input
              autoFocus
              value={naming}
              maxLength={60}
              className="h-8 w-48"
              aria-label="Group name"
              onChange={(event) => setNaming(event.target.value)}
            />
            <Button size="xs" type="submit">
              Save
            </Button>
            <Button size="xs" variant="ghost" type="button" onClick={() => setNaming(null)}>
              Cancel
            </Button>
          </form>
        ) : group.app ? null : (
          <>
            <Button size="xs" variant="ghost" onClick={() => setNaming(group.title)}>
              Rename
            </Button>
            {group.key === 'other' ? null : (
              <Button
                size="xs"
                variant="ghost"
                disabled={remove.isPending}
                aria-label={`Delete ${group.title}`}
                onClick={() => remove.mutate()}
              >
                Delete
              </Button>
            )}
          </>
        )}
        <Switch
          checked={!group.off}
          disabled={change.isPending}
          aria-label={`${group.title} ${group.off ? 'off' : 'on'}`}
          onCheckedChange={(on) => change.mutate({ off: !on })}
        />
      </div>
      {group.purpose ? <p className="-mt-1 px-10 pb-2 text-xs text-muted-foreground">{group.purpose}</p> : null}
      <CollapsibleContent>
        {group.off && !group.app ? (
          <p className="px-10 pb-2 text-xs text-muted-foreground">
            New tools the server adds to this group start off too. Turn one on here to keep it on anyway.
          </p>
        ) : null}
        <ul>
          {members.map((tool) => (
            <ToolLine key={tool.name} tool={tool} groups={groups} upstream={upstream} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

export const GroupsView = ({
  upstream,
  tools,
  composio,
}: {
  upstream: string
  tools: ToolCard[]
  composio: boolean
}) => {
  const refresh = useRefresh(upstream)
  const view = useQuery(groupsQuery(upstream))
  const [adding, setAdding] = useState('')
  const effect = useMutation({
    mutationFn: ({ which, off }: { which: 'reads' | 'changes' | 'deletes'; off: boolean }) =>
      unwrap(
        api.PATCH('/api/upstreams/{id}/effects/{effect}', {
          params: { path: { id: upstream, effect: which } },
          body: { off },
        }),
      ),
    onSuccess: (data) => refresh(data),
    onError: (error) => toast.error(error.message),
  })
  const add = useMutation({
    mutationFn: (value: string) =>
      unwrap(
        api.POST('/api/upstreams/{id}/groups', {
          params: { path: { id: upstream } },
          body: composio ? { app: value } : { title: value },
        }),
      ),
    onSuccess: (data) => {
      refresh(data)
      setAdding('')
      toast.success(composio ? 'App added and fetched.' : 'Group added: move tools into it.')
    },
    onError: (error) => toast.error(error.message),
  })
  if (view.isPending) return <Skeleton className="h-40 rounded-none" />
  if (view.error) return <p className="border border-border bg-card p-5 text-sm text-error">{view.error.message}</p>
  const data = view.data
  return (
    <div className="flex flex-col gap-3">
      <RegroupCard upstream={upstream} view={data} onApplied={(next) => refresh(next)} />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border border-border bg-card px-4 py-3">
        {data.effects.map((entry) => (
          <label key={entry.effect} className="flex items-center gap-2 text-sm">
            <Switch
              checked={!entry.off}
              disabled={effect.isPending || !entry.tools}
              aria-label={`${EFFECT_LABEL[entry.effect]} ${entry.off ? 'off' : 'on'}`}
              onCheckedChange={(on) => effect.mutate({ which: entry.effect, off: !on })}
            />
            <span className={cn(entry.off && 'text-muted-foreground', entry.effect === 'deletes' && 'text-error')}>
              {EFFECT_LABEL[entry.effect]}
            </span>
            <span className="font-mono text-xs text-faint-foreground">{entry.tools}</span>
          </label>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {data.yours ? `${yoursLine(data.yours)} ` : ''}
          {groupedByLine(data.groupedBy)}
        </span>
      </div>
      <div className="border border-border bg-card">
        {data.groups.map((group) => (
          <GroupRow key={group.key} group={group} groups={data.groups} tools={tools} upstream={upstream} />
        ))}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (adding.trim()) add.mutate(adding.trim())
        }}
      >
        <Input
          value={adding}
          maxLength={60}
          className="h-8 w-64"
          placeholder={composio ? 'Another app, by its Composio slug' : 'A group of your own'}
          aria-label={composio ? 'Add a Composio app' : 'New group'}
          onChange={(event) => setAdding(event.target.value)}
        />
        <Button size="sm" variant="ghost" type="submit" disabled={!adding.trim() || add.isPending}>
          <IconPlus /> {composio ? 'Add app' : 'Add group'}
        </Button>
      </form>
    </div>
  )
}
