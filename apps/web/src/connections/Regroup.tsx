/**
 * Regrouping a connection with the models: ask, see the proposal beside today's groups with every tool that would
 * move and where from, then apply or keep what there is. Tools the owner moved and tools in a group switched off stay
 * where they are. Without smart grouping set up, the card offers the setup instead.
 */
import { IconSparkles } from '@tabler/icons-react'
import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { api, type Schemas, unwrap } from '@/api/client'
import { Mono } from '@/ui/Code'
import { Button } from '@/ui/shadcn/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/shadcn/dialog'
import { arrivalsOf } from './groups.rules'

type Groups = Schemas['ToolGroups']
type Proposal = Schemas['Regroup']

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const short = (tool: string) => tool.slice(tool.indexOf('.') + 1)

const Head = ({ title, tools, off }: { title: string; tools: number; off: boolean }) => (
  <span className="flex items-baseline justify-between gap-2 text-sm">
    <span className="font-medium">{title}</span>
    <span className="shrink-0 text-xs text-muted-foreground">
      {plural(tools, 'tool')}
      {off ? ' · off' : ''}
    </span>
  </span>
)

/** Today's groups on the left; on the right the proposed ones, each tool that moves marked with where it comes from. */
export const ProposalColumns = ({ proposal }: { proposal: Proposal }) => (
  <div className="grid gap-4 sm:grid-cols-2">
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-xs tracking-wide text-muted-foreground uppercase">Now</span>
      <ul className="flex flex-col border border-border">
        {proposal.before
          .filter((group) => group.tools.length)
          .map((group) => (
            <li key={group.key} className="border-b border-border px-3 py-2 last:border-b-0">
              <Head title={group.title} tools={group.tools.length} off={group.off} />
            </li>
          ))}
      </ul>
    </div>
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-xs tracking-wide text-muted-foreground uppercase">Proposed</span>
      <ul className="flex flex-col border border-border">
        {arrivalsOf(proposal).map((group) => {
          const moving = group.tools.filter((tool) => tool.from).length
          return (
            <li key={group.key} className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0">
              <Head title={group.title} tools={group.tools.length} off={group.off} />
              {group.purpose ? <span className="text-xs text-muted-foreground">{group.purpose}</span> : null}
              <details open={moving > 0 && group.tools.length <= 8}>
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  {moving ? `${plural(moving, 'tool')} would move here` : 'No tool moves here'}
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {group.tools.map((tool) => (
                    <li key={tool.name} className="flex items-baseline justify-between gap-2 text-xs">
                      <Mono className="min-w-0 truncate text-xs">{short(tool.name)}</Mono>
                      {tool.from ? <span className="shrink-0 text-primary">from {tool.from}</span> : null}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          )
        })}
      </ul>
    </div>
  </div>
)

/** The groups to send back when applying a proposal. */
export const groupsToApply = (proposal: Proposal) => proposal.after.map(({ off: _, ...group }) => group)

export const RegroupCard = ({
  upstream,
  view,
  onApplied,
}: {
  upstream: string
  view: Groups
  onApplied: (view: Groups) => void
}) => {
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const ask = useMutation({
    mutationFn: () => unwrap(api.POST('/api/upstreams/{id}/regroup', { params: { path: { id: upstream } } })),
    onSuccess: setProposal,
    onError: (error) => toast.error(error.message),
  })
  const apply = useMutation({
    mutationFn: (groups: ReturnType<typeof groupsToApply>) =>
      unwrap(api.PUT('/api/upstreams/{id}/groups', { params: { path: { id: upstream } }, body: { groups } })),
    onSuccess: (data) => {
      onApplied(data)
      setProposal(null)
      toast.success('Regrouped. Your switches and the tools you moved are as they were.')
    },
    onError: (error) => toast.error(error.message),
  })
  if (view.groupedBy === 'apps') return null
  if (!view.smart)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-mist/40 px-4 py-3 text-sm">
        <span className="flex items-center gap-2">
          <IconSparkles className="size-4 text-primary" />
          These groups come from rules. Let a model group them by what the tools do.
        </span>
        <Button asChild size="sm" variant="ghost">
          <Link to="/settings">Set up in 2 minutes</Link>
        </Button>
      </div>
    )
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-4 py-3 text-sm">
        <span className="flex items-center gap-2 text-muted-foreground">
          <IconSparkles className="size-4 text-primary" />
          {view.groupedBy === 'ai'
            ? 'Ask the model again when the server has changed a lot. You see every move first.'
            : 'The model can group these by what they do. You see every move first.'}
        </span>
        <Button size="sm" variant="ghost" disabled={ask.isPending} onClick={() => ask.mutate()}>
          {ask.isPending ? 'Asking the models…' : view.groupedBy === 'ai' ? 'Regroup' : 'Regroup with AI'}
        </Button>
      </div>
      <Dialog open={Boolean(proposal)} onOpenChange={(open) => (open ? null : setProposal(null))}>
        <DialogContent className="flex max-h-[90vh] flex-col gap-4 overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Regroup {upstream}?</DialogTitle>
            <DialogDescription>
              {proposal
                ? `${plural(proposal.moves, 'tool')} would change group. ${proposal.kept.length ? `${plural(proposal.kept.length, 'tool')} stay where they are: you moved them, or their group is yours or off.` : ''}`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {proposal ? <ProposalColumns proposal={proposal} /> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setProposal(null)}>
              Keep what there is
            </Button>
            <Button
              variant="primary"
              disabled={!proposal || apply.isPending}
              onClick={() => proposal && apply.mutate(groupsToApply(proposal))}
            >
              {apply.isPending ? 'Applying…' : 'Apply'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
