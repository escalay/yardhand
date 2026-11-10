/** Agents: every key, what it reaches, when it last called, and how busy it was this week. */
import { IconPlus } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Client } from '@/api/client'
import { expiryOf } from '@/packs/packs.rules'
import { cn } from '@/ui/cn'
import { Empty } from '@/ui/Empty'
import { ago, plural } from '@/ui/format'
import { Page, PageHeader } from '@/ui/Page'
import { Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { foundOf, reachOf } from './agents.rules'
import { clientsQuery } from './queries'

const NewButton = () => (
  <Button asChild variant="primary">
    <Link to="/agents/new">
      <IconPlus /> Give an agent a key
    </Link>
  </Button>
)

const AgentTable = ({ rows }: { rows: Client[] }) => (
  <div className="overflow-x-auto border border-border bg-card">
    <table className="w-full min-w-[44rem] text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs tracking-wide text-muted-foreground uppercase">
          <th className="px-4 py-3 font-normal">Agent</th>
          <th className="px-4 py-3 font-normal">Reaches</th>
          <th className="px-4 py-3 font-normal">Last call</th>
          <th className="px-4 py-3 font-normal" title="Searches this week followed by a call to a tool it found">
            Found
          </th>
          <th className="px-4 py-3 text-right font-normal">This week</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            className={cn(
              'border-b border-border last:border-b-0 hover:bg-muted',
              (row.revokedAt || expiryOf(row.expiresAt).expired) && 'text-faint-foreground',
            )}
          >
            <td className="px-4 py-3">
              <Link to="/agents/$id" params={{ id: row.id }} className="flex flex-col">
                <span className="font-medium">{row.name}</span>
                <span className="text-xs text-muted-foreground">
                  {row.kind === 'oauth' ? 'OAuth' : 'Key'}
                  {row.revokedAt
                    ? ` · revoked ${ago(row.revokedAt)}`
                    : row.expiresAt
                      ? ` · ${expiryOf(row.expiresAt).text.toLowerCase()}`
                      : ` · made ${ago(row.createdAt)}`}
                </span>
              </Link>
            </td>
            <td className="px-4 py-3 text-muted-foreground">{reachOf(row)}</td>
            <td className="px-4 py-3">
              {row.revokedAt || expiryOf(row.expiresAt).expired ? (
                '–'
              ) : row.usage.lastCallAt ? (
                ago(row.usage.lastCallAt)
              ) : (
                <Status tone="warn">Never used</Status>
              )}
            </td>
            <td className="px-4 py-3 font-mono text-xs">
              {foundOf(row.usage).struggling ? (
                <Status tone="warn">{foundOf(row.usage).text}</Status>
              ) : (
                foundOf(row.usage).text
              )}
            </td>
            <td className="px-4 py-3 text-right font-mono text-xs">
              {row.usage.calls7d ? plural(row.usage.calls7d, 'call') : '–'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

export const AgentsPage = () => {
  const clients = useQuery(clientsQuery)
  const rows = clients.data?._embedded.clients ?? []
  const gone = (row: Client) => Boolean(row.revokedAt) || expiryOf(row.expiresAt).expired
  const active = rows.filter((row) => !gone(row))
  const revoked = rows.filter(gone)
  return (
    <Page>
      <PageHeader
        label="Agents"
        title={
          <>
            Who may <em>use</em> Yardhand
          </>
        }
        actions={active.length ? <NewButton /> : null}
      >
        A key per agent or machine. OAuth agents (claude.ai) appear here on their own after approving.
      </PageHeader>
      {clients.isPending ? (
        <Skeleton className="h-64 rounded-none" />
      ) : clients.error ? (
        <Empty illustration="storm" title="Agents didn't load">
          {clients.error.message}
        </Empty>
      ) : active.length ? (
        <div className="flex flex-col gap-8">
          <AgentTable rows={active} />
          {revoked.length ? (
            <details className="group flex flex-col gap-3">
              <summary className="cursor-pointer text-xs tracking-wide text-muted-foreground uppercase select-none hover:text-foreground">
                Revoked or expired · {revoked.length}
              </summary>
              <div className="mt-3">
                <AgentTable rows={revoked} />
              </div>
            </details>
          ) : null}
        </div>
      ) : (
        <Empty illustration="agents" title="No agent has a key yet" action={<NewButton />}>
          Make one for Claude Code, Cursor, Codex or a script. It comes with the setup to paste, and you'll see its
          first call land.
        </Empty>
      )}
    </Page>
  )
}
