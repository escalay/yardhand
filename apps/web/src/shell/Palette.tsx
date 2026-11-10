/**
 * ⌘K from anywhere: go to a place, run an action, or find a tool by what it does (with the playbooks made for it), a
 * connection, its manual or an agent by name. Tool search is the same search agents use (words and meaning).
 */
import { IconArrowRight, IconBook, IconKey, IconListCheck, IconPlug, IconPlus, IconTool } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, unwrap } from '@/api/client'
import { shortTitleOf } from '@/connections/connections.rules'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/ui/shadcn/command'
import { PLACES } from './nav'

const useDebounced = <Value,>(value: Value, ms = 200) => {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

export const Palette = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const words = useDebounced(q.trim())
  const tools = useQuery({
    queryKey: ['tools', 'palette', words],
    queryFn: () => unwrap(api.GET('/api/tools', { params: { query: { q: words, limit: 8 } } })),
    enabled: open && words.length > 1,
  })
  const upstreams = useQuery({
    queryKey: ['upstreams'],
    queryFn: () => unwrap(api.GET('/api/upstreams')),
    enabled: open,
  })
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => unwrap(api.GET('/api/clients')), enabled: open })
  const go = (to: string, params?: Record<string, string>, search?: Record<string, string>) => {
    onOpenChange(false)
    setQ('')
    void navigate({ to: to as never, params: params as never, search: search as never })
  }
  const playbookUpstream = (name: string) =>
    upstreams.data?._embedded.upstreams.find((upstream) => name.startsWith(`${upstream.id}-`))?.id

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Go anywhere"
      description="Places, actions, tools, playbooks, connections, manuals and agents"
    >
      <CommandInput value={q} onValueChange={setQ} placeholder="Search tools by what they do, or jump to a place…" />
      <CommandList>
        <CommandEmpty>Nothing matches. Tools are searched by what they do: try a verb.</CommandEmpty>
        {words.length > 1 && tools.data?._embedded.tools.length ? (
          <CommandGroup heading="Tools">
            {tools.data._embedded.tools.map((tool) => (
              <CommandItem
                key={tool.name}
                value={`tool ${tool.name} ${words}`}
                onSelect={() => go('/tools/$name', { name: tool.name })}
              >
                <IconTool />
                <span className="font-mono text-[13px]">{tool.name}</span>
                <span className="truncate text-muted-foreground">{tool.summary}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {words.length > 1 && tools.data?.playbooks.length ? (
          <CommandGroup heading="Playbooks">
            {tools.data.playbooks.map((playbook) => (
              <CommandItem
                key={playbook.name}
                value={`playbook ${playbook.name} ${words}`}
                onSelect={() => {
                  const id = playbookUpstream(playbook.name)
                  if (id) go('/connections/$id', { id }, { tab: 'playbooks' })
                }}
              >
                <IconListCheck />
                <span>{playbook.title}</span>
                <span className="truncate text-muted-foreground">{playbook.description}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        <CommandGroup heading="Go to">
          {PLACES.map((place) => (
            <CommandItem key={place.to} value={`go ${place.label} ${place.hint}`} onSelect={() => go(place.to)}>
              <place.icon />
              {place.label}
              <span className="truncate text-muted-foreground">{place.hint}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Do">
          <CommandItem value="add a connection server mcp api" onSelect={() => go('/connections/new')}>
            <IconPlus /> Add a connection
          </CommandItem>
          <CommandItem value="give an agent a key new client" onSelect={() => go('/agents/new')}>
            <IconKey /> Give an agent a key
          </CommandItem>
          <CommandItem value="review changes tools manuals playbooks approve" onSelect={() => go('/tools/reviews')}>
            <IconArrowRight /> Review changes
          </CommandItem>
        </CommandGroup>
        {upstreams.data?._embedded.upstreams.length ? (
          <CommandGroup heading="Connections">
            {upstreams.data._embedded.upstreams.map((upstream) => (
              <CommandItem
                key={upstream.id}
                value={`connection ${upstream.id} ${upstream.title}`}
                onSelect={() => go('/connections/$id', { id: upstream.id })}
              >
                <IconPlug /> {shortTitleOf(upstream.title)}
                <span className="font-mono text-xs text-muted-foreground">{upstream.id}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {upstreams.data?._embedded.upstreams.some((upstream) => upstream.offers.manuals) ? (
          <CommandGroup heading="Manuals">
            {upstreams.data._embedded.upstreams
              .filter((upstream) => upstream.offers.manuals)
              .map((upstream) => (
                <CommandItem
                  key={upstream.id}
                  value={`manual ${upstream.id} ${upstream.title} how to use`}
                  onSelect={() => go('/connections/$id', { id: upstream.id }, { tab: 'manual' })}
                >
                  <IconBook /> {shortTitleOf(upstream.title)} manual
                </CommandItem>
              ))}
          </CommandGroup>
        ) : null}
        {clients.data?._embedded.clients.length ? (
          <CommandGroup heading="Agents">
            {clients.data._embedded.clients
              .filter((client) => !client.revokedAt)
              .map((client) => (
                <CommandItem
                  key={client.id}
                  value={`agent ${client.name} ${client.id}`}
                  onSelect={() => go('/agents/$id', { id: client.id })}
                >
                  <IconKey /> {client.name}
                </CommandItem>
              ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  )
}

/** ⌘K / Ctrl+K opens it; returns its state. */
export const usePaletteShortcut = () => {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((was) => !was)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
  return [open, setOpen] as const
}
