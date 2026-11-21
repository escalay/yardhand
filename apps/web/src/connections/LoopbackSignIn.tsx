/**
 * Signing in as an app on this computer, for servers that refuse to send the owner back to a web app they don't
 * know: the approval ends on a localhost page that never loads, and its address is pasted here to finish.
 */
import { IconClipboard, IconExternalLink } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { api, unwrap } from '@/api/client'
import { cn } from '@/ui/cn'
import { plural } from '@/ui/format'
import { Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'
import { finishProblemOf, pastedApprovalOf } from './connections.rules'

const Step = ({ n, title, children }: { n: number; title: React.ReactNode; children?: React.ReactNode }) => (
  <li className="flex gap-3">
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-card text-xs font-medium tabular-nums">
      {n}
    </span>
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
      <span className="text-sm font-medium">{title}</span>
      {children}
    </div>
  </li>
)

const canReadClipboard = () => typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.readText)

export const LoopbackSignIn = ({
  id,
  title,
  open = false,
  onConnected,
}: {
  id: string
  title: string
  /** Already started through loopback: show the paste step straight away. */
  open?: boolean
  onConnected?: () => void
}) => {
  const queries = useQueryClient()
  const [pasting, setPasting] = useState(open)
  const [address, setAddress] = useState('')
  const pasted = pastedApprovalOf(address)

  const start = useMutation({
    mutationFn: async (via: 'gateway' | 'loopback') => {
      // Opened now, while the click still counts, so the browser doesn't block it
      const tab = window.open('', '_blank')
      const connect = await unwrap(
        api.POST('/api/upstreams/{id}/connect', { params: { path: { id }, query: { via } } }),
      )
      if (connect.authorizeUrl && tab) tab.location.href = connect.authorizeUrl
      else tab?.close()
      return connect
    },
    onSuccess: (connect) => {
      setAddress('')
      finish.reset()
      if (connect.connected) {
        toast.success('Already connected: its sign-in still works.')
        onConnected?.()
      } else {
        // The usual sign-in comes back to the gateway by itself; loopback needs the address pasted
        setPasting(connect.via === 'loopback')
        if (connect.via === 'gateway') toast.success(`Approve ${title} in the tab that opened.`)
      }
    },
    onError: (error) => toast.error(error.message),
  })
  const finish = useMutation({
    mutationFn: (url: string) =>
      unwrap(api.POST('/api/upstreams/{id}/connect/complete', { params: { path: { id } }, body: { url } })),
    onSuccess: (done) => {
      toast.success(`${title} connected: ${plural(done.tools, 'tool')} live or waiting for review.`)
      setPasting(false)
      setAddress('')
      void queries.invalidateQueries({ queryKey: ['upstream', id] })
      void queries.invalidateQueries({ queryKey: ['upstreams'] })
      void queries.invalidateQueries({ queryKey: ['tools'] })
      onConnected?.()
    },
  })

  /** Takes the field's text; a pasted address that carries the approval finishes at once (typing waits for Enter). */
  const take = (text: string, pastedIn: boolean) => {
    setAddress(text)
    finish.reset()
    const check = pastedApprovalOf(text)
    if (pastedIn && check.ready && !finish.isPending) finish.mutate(check.url)
  }
  const fromClipboard = async () => {
    try {
      take(await navigator.clipboard.readText(), true)
    } catch {
      toast.error('The browser didn’t share the clipboard. Paste into the field instead (⌘V or Ctrl+V).')
    }
  }

  if (!pasting)
    return (
      <div className="flex flex-col gap-2 border-b border-border px-5 py-4 text-left last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Its sign-in page says it can't connect this app? Some servers only sign in apps on your own computer.
        </p>
        <Button size="sm" variant="muted" onClick={() => start.mutate('loopback')} disabled={start.isPending}>
          <IconExternalLink /> Sign in as an app on this computer
        </Button>
      </div>
    )

  const problem = finish.error ? finishProblemOf(finish.error.message) : pasted.ready ? null : pasted.problem
  return (
    <form
      className="flex flex-col gap-4 border-b border-border bg-muted/50 px-5 py-5 text-left last:border-b-0"
      onSubmit={(event) => {
        event.preventDefault()
        if (pasted.ready) finish.mutate(pasted.url)
      }}
    >
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Finish signing in to {title}</span>
        <p className="text-sm text-pretty text-muted-foreground">
          {title} sends its approval back to your computer, not to Yardhand. So after you allow access, its tab ends on
          a page that can't load. That's expected: the page's address carries the approval, and you bring it here.
        </p>
      </div>

      <ol className="flex flex-col gap-4">
        <Step n={1} title={<>Click Allow in the {title} tab that opened</>}>
          <span className="text-sm text-muted-foreground">
            No tab?{' '}
            <button
              type="button"
              className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
              onClick={() => start.mutate('loopback')}
              disabled={start.isPending}
            >
              Open it again
            </button>
          </span>
        </Step>
        <Step n={2} title="In that tab, copy the whole address from the address bar">
          <span className="text-sm text-muted-foreground">
            The page says it can't be reached. Its address starts with{' '}
            <span className="font-mono text-foreground">localhost:8765/callback?code=</span>
          </span>
        </Step>
        <Step n={3} title="Paste it here">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label="Address the approval ended on"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={address}
              onChange={(event) => take(event.target.value, event.target.value.length - address.length > 12)}
              placeholder="http://localhost:8765/callback?code=…"
              aria-invalid={Boolean(problem)}
              className={cn('font-mono', problem && 'border-error')}
            />
            {canReadClipboard() ? (
              <Button type="button" variant="muted" onClick={() => void fromClipboard()} disabled={finish.isPending}>
                <IconClipboard /> Paste
              </Button>
            ) : null}
          </div>
          {finish.isPending ? (
            <Status tone="live">Connecting to {title}…</Status>
          ) : problem ? (
            <p role="alert" className="text-sm text-error">
              {problem}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">It connects as soon as you paste.</p>
          )}
        </Step>
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => start.mutate('gateway')}
          disabled={start.isPending}
        >
          Use the usual sign-in instead
        </Button>
        {pasted.ready && finish.isError ? (
          <Button type="submit" size="sm" variant="primary">
            Try again
          </Button>
        ) : null}
      </div>
    </form>
  )
}
