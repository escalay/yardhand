/**
 * A Composio connection's accounts, by app, with the labels given them in Composio: what a pack fixes a tool to, and
 * what a call's `account` input takes. Adding tools to a pack picks among these.
 */
import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import { Mono } from '@/ui/Code'
import { Status } from '@/ui/Status'
import { Skeleton } from '@/ui/shadcn/skeleton'

export const AccountsTab = ({ upstream }: { upstream: string }) => {
  const accounts = useQuery({
    queryKey: ['accounts', upstream],
    queryFn: () => unwrap(api.GET('/api/upstreams/{id}/accounts', { params: { path: { id: upstream } } })),
  })
  if (accounts.isPending) return <Skeleton className="h-40 rounded-none" />
  if (accounts.error)
    return (
      <p className="border border-border bg-card p-5 text-sm text-error">
        Can’t read its accounts: {accounts.error.message}
      </p>
    )
  const list = accounts.data._embedded.accounts
  const apps = [...new Set(list.map((account) => account.toolkit))]
  return (
    <div className="flex flex-col gap-4">
      {apps.map((app) => (
        <section key={app} className="border border-border bg-card">
          <div className="border-b border-border bg-muted px-4 py-2 text-xs tracking-wide text-muted-foreground uppercase">
            {app}
          </div>
          <ul>
            {list
              .filter((account) => account.toolkit === app)
              .map((account) => (
                <li
                  key={account.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-3 text-sm last:border-b-0"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">{account.label}</span>
                    <Mono className="text-xs text-muted-foreground">{account.id}</Mono>
                  </span>
                  <span className="flex items-center gap-2">
                    {account.isDefault ? <span className="text-xs text-muted-foreground">default</span> : null}
                    <Status tone={account.status === 'ACTIVE' ? 'ok' : 'error'}>{account.status.toLowerCase()}</Status>
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ))}
      <p className="text-sm text-muted-foreground">
        A call picks one with <Mono className="text-xs">account</Mono>; left out, it runs on the default. A pack fixes
        it per tool, so its keys never see or change it: add the tools to a pack and choose the account there.
      </p>
    </div>
  )
}
