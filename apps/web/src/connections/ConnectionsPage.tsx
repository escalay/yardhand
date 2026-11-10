/** Connections: every server behind the gateway, how it is, and how many tools it brings. */
import { IconPlus } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Empty } from '@/ui/Empty'
import { ago, plural } from '@/ui/format'
import { Page, PageHeader } from '@/ui/Page'
import { HEALTH, Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { kindLabel, offersLine } from './connections.rules'
import { upstreamsQuery } from './queries'

const AddButton = () => (
  <Button asChild variant="primary">
    <Link to="/connections/new">
      <IconPlus /> Add a connection
    </Link>
  </Button>
)

export const ConnectionsPage = () => {
  const upstreams = useQuery(upstreamsQuery)
  const rows = upstreams.data?._embedded.upstreams ?? []
  return (
    <Page>
      <PageHeader
        label="Connections"
        title={
          <>
            The servers <em>behind</em> the door
          </>
        }
        actions={rows.length ? <AddButton /> : null}
      >
        Each one's key or sign-in is stored once, sealed. Agents reach their tools through Yardhand and never see it.
      </PageHeader>
      {upstreams.isPending ? (
        <Skeleton className="h-64 rounded-none" />
      ) : upstreams.error ? (
        <Empty illustration="storm" title="Connections didn't load">
          {upstreams.error.message}
        </Empty>
      ) : rows.length ? (
        <ul className="grid border-t border-l border-border bg-card sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => {
            const health = HEALTH[row.status] ?? { tone: 'neutral' as const, label: row.status }
            return (
              <li key={row.id} className="border-r border-b border-border">
                <Link
                  to="/connections/$id"
                  params={{ id: row.id }}
                  className="flex h-full flex-col gap-10 p-5 transition-colors hover:bg-muted"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-xs tracking-wide text-muted-foreground uppercase">
                      {kindLabel(row.kind)} · <span className="font-mono normal-case">{row.id}</span>
                    </span>
                    <Status tone={row.enabled ? health.tone : 'neutral'}>
                      {row.enabled ? health.label : 'Switched off'}
                    </Status>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-base font-medium">{row.title}</span>
                    <span className="text-sm text-muted-foreground">
                      {plural(row.toolCount, 'tool')}
                      {offersLine(row.offers) ? `, ${offersLine(row.offers)}` : ''} · synced {ago(row.syncedAt)}
                      {row.trust === 'review' ? ' · changes reviewed' : ''}
                    </span>
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      ) : (
        <Empty illustration="connections" title="Nothing connected yet" action={<AddButton />}>
          Paste the address of an MCP server or a REST API with an OpenAPI spec. Yardhand works out the rest.
        </Empty>
      )}
    </Page>
  )
}
