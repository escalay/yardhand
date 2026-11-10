/**
 * Regrouping every connection with the models, in one sitting: each is asked in turn and shows what would change;
 * only the ones the owner has ticked are applied. A Composio connection is left out (its groups are its apps).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api, type Schemas, unwrap } from '@/api/client'
import { Button } from '@/ui/shadcn/button'
import { Checkbox } from '@/ui/shadcn/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/shadcn/dialog'
import { regroupLine } from './groups.rules'
import { upstreamsQuery } from './queries'
import { groupsToApply, ProposalColumns } from './Regroup'

type Proposal = Schemas['Regroup']
type Row = { id: string; title: string; proposal?: Proposal; error?: string; applied?: boolean }

const Asked = ({ rows, onDone }: { rows: Row[]; onDone: () => void }) => {
  const queries = useQueryClient()
  const [state, setState] = useState(rows)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const started = useRef(false)
  const patch = (id: string, change: Partial<Row>) =>
    setState((now) => now.map((row) => (row.id === id ? { ...row, ...change } : row)))
  // One connection at a time: each is two model calls or more
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      for (const row of rows)
        await unwrap(api.POST('/api/upstreams/{id}/regroup', { params: { path: { id: row.id } } }))
          .then((proposal) => patch(row.id, { proposal }))
          .catch((error: Error) => patch(row.id, { error: error.message }))
    })()
  })
  const changing = state.filter((row) => row.proposal?.moves && !row.applied)
  const asking = state.some((row) => !row.proposal && !row.error)
  const toggle = (id: string, on: boolean) =>
    setTicked((now) => {
      const next = new Set(now)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const apply = async () => {
    setApplying(true)
    let done = 0
    for (const row of changing.filter((entry) => ticked.has(entry.id))) {
      if (!row.proposal) continue
      await unwrap(
        api.PUT('/api/upstreams/{id}/groups', {
          params: { path: { id: row.id } },
          body: { groups: groupsToApply(row.proposal) },
        }),
      )
        .then(() => {
          done += 1
          patch(row.id, { applied: true })
        })
        .catch((error: Error) => patch(row.id, { error: error.message }))
    }
    setApplying(false)
    setTicked(new Set())
    for (const key of [['groups'], ['tools'], ['tool'], ['upstreams']])
      void queries.invalidateQueries({ queryKey: key })
    if (done) toast.success(`Regrouped ${done} connection${done === 1 ? '' : 's'}. Your switches are as they were.`)
  }
  return (
    <>
      <ul className="flex flex-col border border-border">
        {state.map((row) => (
          <li key={row.id} className="flex flex-col gap-2 border-b border-border px-3 py-2.5 last:border-b-0">
            <div className="flex items-center gap-3 text-sm">
              <Checkbox
                aria-label={`Regroup ${row.title}`}
                checked={ticked.has(row.id)}
                disabled={!row.proposal?.moves || row.applied || applying}
                onCheckedChange={(on) => toggle(row.id, on === true)}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
              <span className={row.error ? 'text-xs text-error' : 'text-xs text-muted-foreground'}>
                {row.error ??
                  (row.applied ? 'Regrouped' : row.proposal ? regroupLine(row.proposal) : 'Asking the models…')}
              </span>
            </div>
            {row.proposal?.moves && !row.applied ? (
              <details className="pl-7">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  See every move
                </summary>
                <div className="pt-2">
                  <ProposalColumns proposal={row.proposal} />
                </div>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!changing.length || applying}
          onClick={() => setTicked(new Set(changing.map((row) => row.id)))}
        >
          Tick all that change
        </Button>
        <span className="flex gap-2">
          <Button variant="ghost" onClick={onDone}>
            {state.some((row) => row.applied) ? 'Done' : 'Keep what there is'}
          </Button>
          <Button variant="primary" disabled={!ticked.size || applying || asking} onClick={() => void apply()}>
            {applying ? 'Applying…' : `Apply to ${ticked.size || 'the ticked'}`}
          </Button>
        </span>
      </div>
    </>
  )
}

export const RegroupAll = () => {
  const [open, setOpen] = useState(false)
  const upstreams = useQuery(upstreamsQuery)
  const rows = (upstreams.data?._embedded.upstreams ?? [])
    .filter((row) => row.kind !== 'composio' && row.enabled && row.toolCount >= 6)
    .map((row) => ({ id: row.id, title: row.title }))
  if (!rows.length) return null
  return (
    <>
      <Button size="sm" variant="muted" onClick={() => setOpen(true)}>
        Regroup connections…
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90vh] flex-col gap-4 overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Regroup {rows.length} connections</DialogTitle>
            <DialogDescription>
              Each is asked in turn. Nothing changes until you tick a connection and apply; tools you moved and groups
              you switched off stay as they are.
            </DialogDescription>
          </DialogHeader>
          {open ? <Asked rows={rows} onDone={() => setOpen(false)} /> : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
