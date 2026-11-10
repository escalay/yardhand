/**
 * A connection's links: the kinds of links its tools return (`cookbook://recipes/{id}`), which agents read as they come
 * with `read_resource`. The owner can follow one to see what an agent gets.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type UpstreamLink as Link, unwrap } from '@/api/client'
import { Code, Mono } from '@/ui/Code'
import { Markdown } from '@/ui/Markdown'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { linksQuery } from './queries'

const FollowOne = ({ link }: { link: Link }) => {
  const [uri, setUri] = useState(link.uri)
  const read = useMutation({
    mutationFn: () => unwrap(api.GET('/api/resources', { params: { query: { uri, upstream: link.upstream } } })),
  })
  const templated = /\{[^}]+\}/.test(uri)
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          read.mutate()
        }}
      >
        <Input
          aria-label={`A ${link.title ?? 'link'} to follow`}
          value={uri}
          onChange={(event) => setUri(event.target.value)}
          className="min-w-0 flex-1 font-mono"
        />
        <Button type="submit" size="sm" variant="muted" disabled={templated || read.isPending} className="shrink-0">
          {read.isPending ? 'Reading…' : 'Follow'}
        </Button>
      </form>
      {templated ? (
        <p className="text-xs text-muted-foreground">Fill in the parts in braces with a real id first.</p>
      ) : null}
      {read.error ? <p className="text-sm text-error">{read.error.message}</p> : null}
      {read.data
        ? read.data.contents.map((part) =>
            part.text === null ? (
              <p key={part.uri} className="text-sm text-muted-foreground">
                {part.mimeType ?? 'Binary'} content, {Math.round(((part.blob?.length ?? 0) * 3) / 4 / 1024)} KB.
              </p>
            ) : part.mimeType === 'text/markdown' ? (
              <div key={part.uri} className="border border-border bg-card p-4">
                <Markdown>{part.text}</Markdown>
              </div>
            ) : (
              <Code key={part.uri}>{part.mimeType?.includes('json') ? prettyJson(part.text) : part.text}</Code>
            ),
          )
        : null}
    </div>
  )
}

const prettyJson = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

export const LinksTab = ({ upstream }: { upstream: string }) => {
  const links = useQuery(linksQuery(upstream))
  if (links.isPending) return <Skeleton className="h-48 rounded-none" />
  const list = links.data?._embedded.links ?? []
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-pretty text-muted-foreground">
        Its tools return links like these. Agents read them as they come with <Mono>read_resource</Mono> (or{' '}
        <Mono>GET /api/resources?uri=…</Mono>), with this server’s sign-in.
      </p>
      <ul className="border border-border bg-card">
        {list.map((link) => (
          <li key={link.uri} className="flex flex-col gap-3 border-b border-border px-4 py-4 last:border-b-0">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{link.title ?? link.uri}</span>
              <Mono className="text-xs break-all text-muted-foreground">{link.uri}</Mono>
              {link.description ? <p className="text-sm text-muted-foreground">{link.description}</p> : null}
            </div>
            <FollowOne link={link} />
          </li>
        ))}
      </ul>
    </div>
  )
}
