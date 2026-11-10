/**
 * A connection's playbooks: its step-by-step ways to do one task, as agents get them (a slash command in hosts like
 * Claude Code, `get_playbook` elsewhere). The owner can fill one in to read what an agent would be told.
 */
import { IconPlayerPlay } from '@tabler/icons-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Playbook, unwrap } from '@/api/client'
import { systemQuery } from '@/shell/queries'
import { Mono } from '@/ui/Code'
import { CopyButton } from '@/ui/Copy'
import { Field } from '@/ui/Field'
import { Markdown } from '@/ui/Markdown'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/shadcn/sheet'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { messageText, slashCommandOf } from './playbooks.rules'
import { playbooksQuery } from './queries'

const TryIt = ({ playbook, onClose }: { playbook: Playbook | null; onClose: () => void }) => {
  const [values, setValues] = useState<Record<string, string>>({})
  const fill = useMutation({
    mutationFn: (args: Record<string, string>) =>
      unwrap(
        api.GET('/api/playbooks/{name}/messages', {
          params: { path: { name: playbook?.name ?? '' }, query: { arguments: JSON.stringify(args) } },
        }),
      ),
  })
  return (
    <Sheet
      open={Boolean(playbook)}
      onOpenChange={(open) => {
        if (open) return
        setValues({})
        fill.reset()
        onClose()
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle>{playbook?.title}</SheetTitle>
          <SheetDescription className="font-mono text-xs">{playbook?.name}</SheetDescription>
        </SheetHeader>
        {playbook ? (
          <form
            className="flex flex-col gap-4 border-b border-border px-5 py-5"
            onSubmit={(event) => {
              event.preventDefault()
              fill.mutate(values)
            }}
          >
            <p className="text-sm text-pretty text-muted-foreground">{playbook.description}</p>
            {playbook.arguments.map((arg) => (
              <Field
                key={arg.name}
                label={
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono text-[13px]">{arg.name}</span>
                    {arg.required ? <span className="text-xs text-error">required</span> : null}
                  </span>
                }
                hint={arg.description}
              >
                {(id) => (
                  <Input
                    id={id}
                    required={arg.required}
                    value={values[arg.name] ?? ''}
                    onChange={(event) => setValues((current) => ({ ...current, [arg.name]: event.target.value }))}
                  />
                )}
              </Field>
            ))}
            <Button type="submit" className="self-start" disabled={fill.isPending}>
              <IconPlayerPlay /> {fill.isPending ? 'Filling in…' : 'Fill it in'}
            </Button>
            {fill.error ? <p className="text-sm text-error">{fill.error.message}</p> : null}
          </form>
        ) : null}
        {fill.data ? (
          <div className="flex flex-col gap-3 px-5 py-5">
            <span className="text-xs tracking-wide text-muted-foreground uppercase">What the agent is told</span>
            {fill.data.messages.map((message, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: messages have no identity beyond their order
              <div key={index} className="border border-border bg-card p-4">
                <Markdown>{messageText(message)}</Markdown>
              </div>
            ))}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

export const PlaybooksTab = ({ upstream, offered }: { upstream: string; offered: boolean }) => {
  const playbooks = useQuery(playbooksQuery(upstream))
  const serverName = useQuery(systemQuery).data?.serverName
  const [trying, setTrying] = useState<Playbook | null>(null)
  if (playbooks.isPending) return <Skeleton className="h-64 rounded-none" />
  const list = playbooks.data?._embedded.playbooks ?? []
  return (
    <div className="flex flex-col gap-3">
      {offered ? null : (
        <p className="border border-warn/40 bg-warn-soft px-4 py-3 text-sm">
          Not offered to agents: switch “Offer its playbooks” on in Settings to list them again.
        </p>
      )}
      <ul className="border border-border bg-card">
        {list.map((playbook) => (
          <li
            key={playbook.name}
            className="flex flex-col gap-2 border-b border-border px-4 py-4 last:border-b-0 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-medium">{playbook.title}</span>
              <p className="text-sm text-pretty text-muted-foreground">{playbook.description}</p>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                {serverName ? (
                  <>
                    <Mono className="truncate text-xs text-muted-foreground">
                      {slashCommandOf(playbook.name, serverName)}
                    </Mono>
                    <CopyButton text={slashCommandOf(playbook.name, serverName)} size="xs" variant="ghost" />
                  </>
                ) : null}
                {playbook.arguments.length ? (
                  <span className="text-xs text-faint-foreground">
                    takes {playbook.arguments.map((arg) => arg.name).join(', ')}
                  </span>
                ) : null}
              </div>
            </div>
            <Button size="sm" variant="muted" className="shrink-0 self-start" onClick={() => setTrying(playbook)}>
              Try it
            </Button>
          </li>
        ))}
      </ul>
      <TryIt playbook={trying} onClose={() => setTrying(null)} />
    </div>
  )
}
