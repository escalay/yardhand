/**
 * Signing in as an app on this computer, for servers that refuse to send the owner back to a web app they don't
 * know: the approval ends on a localhost page that never loads, and its address is pasted here to finish.
 */
import { IconExternalLink } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { api, unwrap } from '@/api/client'
import { Field } from '@/ui/Field'
import { plural } from '@/ui/format'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'

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

  const start = useMutation({
    mutationFn: async () => {
      // Opened now, while the click still counts, so the browser doesn't block it
      const tab = window.open('', '_blank')
      const connect = await unwrap(
        api.POST('/api/upstreams/{id}/connect', { params: { path: { id }, query: { via: 'loopback' } } }),
      )
      if (connect.authorizeUrl && tab) tab.location.href = connect.authorizeUrl
      else tab?.close()
      return connect
    },
    onSuccess: (connect) => {
      if (connect.connected) {
        toast.success('Already connected: its sign-in still works.')
        onConnected?.()
      } else setPasting(true)
    },
    onError: (error) => toast.error(error.message),
  })
  const finish = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/upstreams/{id}/connect/complete', { params: { path: { id } }, body: { url: address } })),
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

  if (!pasting)
    return (
      <div className="flex flex-col gap-2 border-b border-border px-5 py-4 text-left last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Its sign-in page says it can't connect this app? Some servers only sign in apps on your own computer.
        </p>
        <Button size="sm" variant="muted" onClick={() => start.mutate()} disabled={start.isPending}>
          <IconExternalLink /> Sign in as an app on this computer
        </Button>
      </div>
    )

  return (
    <form
      className="flex flex-col gap-3 border-b border-border bg-muted/50 px-5 py-4 text-left last:border-b-0"
      onSubmit={(event) => {
        event.preventDefault()
        finish.mutate()
      }}
    >
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
        <li>Allow access to {title} in the tab that opened.</li>
        <li>
          It ends on a page that can't load (<span className="font-mono">localhost</span>). That's expected.
        </li>
        <li>Copy that page's whole address and paste it here.</li>
      </ol>
      <Field label="Address the approval ended on" error={finish.error?.message ?? null}>
        {(fieldId) => (
          <Input
            id={fieldId}
            required
            autoComplete="off"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="http://localhost:8765/callback?code=…"
            className="font-mono"
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={!address || finish.isPending}>
          {finish.isPending ? 'Connecting…' : 'Finish connecting'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => start.mutate()} disabled={start.isPending}>
          Open the sign-in again
        </Button>
      </div>
    </form>
  )
}
