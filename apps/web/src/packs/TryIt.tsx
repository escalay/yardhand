/**
 * Try a pack as an agent would: one search of it, answered exactly as its keys are answered (the same bar, names and
 * wording, and the same word on what the pack covers when nothing fits), as the pack or as one of its keys. Never
 * logged; the first search ticks the pack's "Try it" step.
 */
import { IconPlus, IconSearch } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { Pack } from '@/api/client'
import { Mono } from '@/ui/Code'
import { Section } from '@/ui/Page'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/shadcn/select'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { coversLine, emptyLine, hiddenLine, lineOf, stoodOutLine } from './packs.rules'
import { packListedQuery, packQuery, packTryQuery, TRY_LIMIT } from './queries'

/** The panel's place on the Overview, for links that lead to it. */
export const TRY_ID = 'try'
const ME = 'me'

export const TryIt = ({ pack }: { pack: Pack }) => {
  const queries = useQueryClient()
  const [as, setAs] = useState<string>()
  const [words, setWords] = useState('')
  const [q, setQ] = useState('')
  const found = useQuery({ ...packTryQuery(pack.name, as, q), enabled: Boolean(q) })
  const listed = useQuery({ ...packListedQuery(pack.name, as), enabled: Boolean(q) })

  const box = useRef<HTMLInputElement>(null)
  const hash = useLocation({ select: (location) => location.hash })
  useEffect(() => {
    if (hash !== TRY_ID) return
    box.current?.scrollIntoView({ block: 'center' })
    box.current?.focus({ preventScroll: true })
  }, [hash])

  // The first search marks the pack tried: read the pack again so its step ticks
  const untried = !pack.triedAt
  const answered = Boolean(found.data)
  useEffect(() => {
    if (answered && untried) void queries.invalidateQueries({ queryKey: packQuery(pack.name).queryKey, exact: true })
  }, [answered, untried, pack.name, queries])

  const tools = found.data?._embedded.tools ?? []
  const hint = found.data?.hint
  const hidden = found.data?.hiddenForScope ?? 0
  return (
    <Section
      title={`Try ${pack.title} as an agent`}
      aside={
        <span className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground">
          See it as
          <Select value={as ?? ME} onValueChange={(value) => setAs(value === ME ? undefined : value)}>
            <SelectTrigger size="sm" aria-label="See it as" className="max-w-36 sm:max-w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ME}>Me</SelectItem>
              {pack.keyList.map((key) => (
                <SelectItem key={key.id} value={key.id}>
                  {key.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </span>
      }
    >
      <div id={TRY_ID} className="flex min-w-0 scroll-mt-24 flex-col border border-border bg-card">
        <form
          className="flex gap-2 border-b border-border p-3"
          onSubmit={(event) => {
            event.preventDefault()
            const next = words.trim()
            if (!next) return
            if (next === q) void found.refetch()
            else setQ(next)
          }}
        >
          <Input
            ref={box}
            value={words}
            maxLength={200}
            aria-label="What an agent would ask"
            placeholder="What an agent would ask, in a few words"
            onChange={(event) => setWords(event.target.value)}
          />
          <Button type="submit" variant="muted" disabled={!words.trim()}>
            <IconSearch /> Search
          </Button>
        </form>
        {!q ? (
          <p className="px-4 py-4 text-sm text-pretty text-muted-foreground">
            {pack.title} is searched here exactly as its keys are: what stands out comes back, and nothing does when
            nothing fits. Searches here aren't logged.
          </p>
        ) : found.isPending ? (
          <div className="p-4">
            <Skeleton className="h-16 rounded-none" />
          </div>
        ) : found.error ? (
          <p className="px-4 py-4 text-sm text-error">{found.error.message}</p>
        ) : tools.length ? (
          <>
            <ol>
              {tools.map((tool, index) => (
                <li key={tool.name} className="flex items-baseline gap-3 border-b border-border px-4 py-2.5">
                  <span className="w-5 shrink-0 text-right font-mono text-xs text-faint-foreground">{index + 1}</span>
                  <span className="flex min-w-0 flex-col gap-x-3 sm:flex-row sm:items-baseline">
                    <Mono className="shrink-0 text-[13px] break-all">{tool.name}</Mono>
                    <span className="truncate text-sm text-muted-foreground">{lineOf(tool)}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="px-4 py-3 text-xs text-muted-foreground">
              {/* A full answer may have been cut: the tools it left out aren't ones that didn't match */}
              {stoodOutLine(tools.length, tools.length < TRY_LIMIT ? listed.data : null)}
              {hidden ? ` · ${hiddenLine(hidden)}` : ''}
            </p>
          </>
        ) : !hint && hidden ? (
          // Matches exist, but this key is not shown them: "nothing matches" would be false
          <p className="px-4 py-4 text-sm">{hiddenLine(hidden)}</p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
            <div className="flex min-w-0 flex-col gap-1 text-sm">
              <p>{emptyLine(hint?.pack.title ?? pack.title, q)}</p>
              {hint ? <p className="text-muted-foreground">{coversLine(hint)}</p> : null}
            </div>
            <Button asChild size="sm" variant="muted">
              <Link to="/packs/$name" params={{ name: pack.name }} search={{ add: true }}>
                <IconPlus /> Add tools
              </Link>
            </Button>
          </div>
        )}
      </div>
    </Section>
  )
}
