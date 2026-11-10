/**
 * Reviews: changes from servers you don't run, waiting for you: tools, manuals, playbooks and links. Each beside what
 * agents use now, line by line; approve or reject one, or a whole server's at once. Agents keep the approved version
 * until you decide.
 */
import { IconAlertTriangle } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import { api, type Review, unwrap } from '@/api/client'
import { flagsQuery } from '@/packs/queries'
import { ToolsTabs } from '@/tools/ToolsTabs'
import { Mono } from '@/ui/Code'
import { cn } from '@/ui/cn'
import { Empty } from '@/ui/Empty'
import { ago, plural } from '@/ui/format'
import { Page, PageHeader, Section } from '@/ui/Page'
import { Button } from '@/ui/shadcn/button'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/shadcn/tabs'
import { type DiffLine, diffLines, looksSteering, stableJson } from './diff.rules'

export const reviewsQuery = { queryKey: ['reviews'], queryFn: () => unwrap(api.GET('/api/reviews')) }

const Lines = ({ lines }: { lines: DiffLine[] }) => (
  <pre className="max-h-96 overflow-auto border border-border bg-card font-mono text-[12.5px] leading-relaxed">
    {lines.map((line, index) => (
      <div
        // biome-ignore lint/suspicious/noArrayIndexKey: a diff line has no identity beyond its place
        key={index}
        className={cn(
          'px-3 whitespace-pre-wrap',
          line.kind === 'removed' && 'bg-error-soft text-error line-through decoration-error/40',
          line.kind === 'added' && 'bg-ok-soft text-foreground',
        )}
      >
        <span aria-hidden="true" className="mr-2 select-none text-faint-foreground">
          {line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' '}
        </span>
        <span className="sr-only">
          {line.kind === 'removed' ? 'removed: ' : line.kind === 'added' ? 'added: ' : ''}
        </span>
        {line.text || ' '}
      </div>
    ))}
  </pre>
)

/** What each kind is called, and the tabs its versions are compared in. */
const KIND: Record<Review['kind'], { noun: string; about: string }> = {
  tool: { noun: 'tool', about: 'the tool' },
  manual: { noun: 'manual', about: 'how to use the server' },
  playbook: { noun: 'playbook', about: 'the task' },
  template: { noun: 'link', about: 'the link' },
  resource: { noun: 'link', about: 'the link' },
}

const ItemLink = ({ review }: { review: Review }) =>
  review.kind === 'tool' ? (
    <Link to="/tools/$name" params={{ name: review.name }} className="hover:underline">
      <Mono>{review.name}</Mono>
    </Link>
  ) : (
    <Link
      to="/connections/$id"
      params={{ id: review.upstream }}
      search={{ tab: review.kind === 'manual' ? 'manual' : review.kind === 'playbook' ? 'playbooks' : 'links' }}
      className="hover:underline"
    >
      <Mono>{review.name}</Mono>
    </Link>
  )

const Change = ({
  review,
  onDecide,
  busy,
}: {
  review: Review
  onDecide: (decision: 'approve' | 'reject') => void
  busy: boolean
}) => {
  const before = review.live
  const proposed = review.proposed
  if (!proposed) return null
  const { noun, about } = KIND[review.kind]
  const said = (side: Review['live']) => `${side?.description ?? ''}\n${side?.body ?? ''}`
  const steering = looksSteering(said(proposed)) && !looksSteering(said(before))
  const text = (side: Review['live']) => side?.body ?? ''
  return (
    <li className="flex flex-col gap-4 border-b border-border p-5 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-3">
          <ItemLink review={review} />
          <span className="text-xs tracking-wide text-muted-foreground uppercase">
            {review.change === 'new' ? `new ${noun}` : `changed ${noun}`}
          </span>
          <span className="text-xs text-faint-foreground">{ago(review.createdAt)}</span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide('reject')}>
            Reject
          </Button>
          <Button size="sm" variant="default" disabled={busy} onClick={() => onDecide('approve')}>
            Approve
          </Button>
        </div>
      </div>
      {steering ? (
        <p className="flex items-center gap-2 border border-warn/40 bg-warn-soft px-3 py-2 text-sm">
          <IconAlertTriangle className="size-4 shrink-0 text-warn" /> The new text talks to the agent rather than about{' '}
          {about}. That's how a server could steer your agents: read it before approving.
        </p>
      ) : null}
      {review.kind === 'tool' ? (
        <Tabs defaultValue="description">
          <TabsList>
            <TabsTrigger value="description">Description</TabsTrigger>
            <TabsTrigger value="input">Input</TabsTrigger>
            <TabsTrigger value="hints">Hints</TabsTrigger>
          </TabsList>
          <TabsContent value="description" className="mt-3">
            <Lines lines={diffLines(before?.description ?? '', proposed.description)} />
          </TabsContent>
          <TabsContent value="input" className="mt-3">
            <Lines lines={diffLines(before ? stableJson(before.inputSchema) : '', stableJson(proposed.inputSchema))} />
          </TabsContent>
          <TabsContent value="hints" className="mt-3">
            <Lines lines={diffLines(before ? stableJson(before.annotations) : '', stableJson(proposed.annotations))} />
          </TabsContent>
        </Tabs>
      ) : (
        <Tabs defaultValue="text">
          <TabsList>
            <TabsTrigger value="text">
              {review.kind === 'manual' ? 'Manual' : review.kind === 'playbook' ? 'Arguments' : 'Address'}
            </TabsTrigger>
            <TabsTrigger value="description">Description</TabsTrigger>
          </TabsList>
          <TabsContent value="text" className="mt-3">
            <Lines lines={diffLines(text(before), text(proposed))} />
          </TabsContent>
          <TabsContent value="description" className="mt-3">
            <Lines lines={diffLines(before?.description ?? '', proposed.description)} />
          </TabsContent>
        </Tabs>
      )}
    </li>
  )
}

/**
 * Pack tools to recheck: wording written for a tool its server has since rewritten (kept for agents until the owner
 * decides), or a fixed input the tool no longer takes (its calls fail until fixed), both settled in the pack.
 */
const PackFlags = () => {
  const flags = useQuery(flagsQuery)
  const rows = flags.data?._embedded.flags ?? []
  if (!rows.length) return null
  return (
    <Section title={`Pack tools to recheck · ${rows.length}`}>
      <ul className="border border-border bg-card">
        {rows.map((flag) => (
          <li
            key={`${flag.pack}:${flag.tool}:${flag.kind}`}
            className="flex flex-col gap-2 border-b border-border px-5 py-4 last:border-b-0 sm:flex-row sm:items-start sm:justify-between"
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <IconAlertTriangle
                  className={`size-4 self-center ${flag.kind === 'input' ? 'text-error' : 'text-warn'}`}
                />
                <Mono className="text-[13px]">{flag.tool}</Mono>
                <span className="text-muted-foreground">in {flag.packTitle}</span>
              </span>
              <span className="line-clamp-2 text-sm text-muted-foreground">
                {flag.kind === 'input'
                  ? `${flag.now}, which the pack fixes: its calls fail until you change what it fixes.`
                  : `Its server now says: ${flag.now}`}
              </span>
            </span>
            <Button asChild size="sm" variant="muted" className="shrink-0">
              <Link to="/packs/$name" params={{ name: flag.pack }}>
                Open the pack
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  )
}

export const ReviewsPage = () => {
  const queries = useQueryClient()
  const reviews = useQuery(reviewsQuery)
  const after = (count: number, decision: 'approve' | 'reject') => {
    toast.success(
      decision === 'approve'
        ? `${plural(count, 'change')} live for agents now.`
        : `${plural(count, 'change')} rejected; agents keep the current version.`,
    )
    for (const key of [['reviews'], ['tools'], ['tool'], ['overview'], ['catalog'], ['packs'], ['pack']])
      void queries.invalidateQueries({ queryKey: key })
  }
  const one = useMutation({
    mutationFn: ({ versionId, decision }: { versionId: string; decision: 'approve' | 'reject' }) =>
      unwrap(api.POST('/api/reviews/{versionId}', { params: { path: { versionId } }, body: { decision } })),
    onSuccess: (_result, { decision }) => after(1, decision),
    onError: (error) => toast.error(error.message),
  })
  const many = useMutation({
    mutationFn: (body: { decision: 'approve' | 'reject'; upstream?: string }) =>
      unwrap(api.POST('/api/reviews', { body })),
    onSuccess: (result, { decision }) => after(result.count, decision),
    onError: (error) => toast.error(error.message),
  })
  const items = reviews.data?._embedded.reviews ?? []
  const groups = Object.entries(
    items.reduce<Record<string, Review[]>>((byUpstream, review) => {
      byUpstream[review.upstream] = [...(byUpstream[review.upstream] ?? []), review]
      return byUpstream
    }, {}),
  )
  const busy = one.isPending || many.isPending

  return (
    <Page>
      <PageHeader
        label="Reviews"
        title={
          <>
            Changes <em>waiting</em> for you
          </>
        }
      >
        Servers you don't run can change their tools, manuals and playbooks. Until you approve, agents keep using the
        version you approved last.
      </PageHeader>
      <ToolsTabs active="reviews" />
      <PackFlags />
      {reviews.isPending ? (
        <Skeleton className="h-64 rounded-none" />
      ) : reviews.error ? (
        <Empty illustration="storm" title="Reviews didn't load">
          {reviews.error.message}
        </Empty>
      ) : groups.length ? (
        groups.map(([upstream, list]) => (
          <Section
            key={upstream}
            title={`${upstream} · ${plural(list.length, 'change')}`}
            aside={
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => many.mutate({ decision: 'reject', upstream })}
                >
                  Reject all
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => many.mutate({ decision: 'approve', upstream })}
                >
                  Approve all
                </Button>
              </div>
            }
          >
            <ul className="border border-border bg-card">
              {list.map((review) => (
                <Change
                  key={review.versionId}
                  review={review}
                  busy={busy}
                  onDecide={(decision) => one.mutate({ versionId: review.versionId, decision })}
                />
              ))}
            </ul>
          </Section>
        ))
      ) : (
        <Empty illustration="all-clear" title="Nothing waiting">
          Everything agents use is a version you approved. When a server you review changes a tool, a manual or a
          playbook, it lands here, and Discord tells you if alerts are on.
        </Empty>
      )}
    </Page>
  )
}
