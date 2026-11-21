/**
 * Where a pack is reached: its one address, what lives under it (MCP, REST, docs), and paste-ready setup per app.
 * The snippets hold `<YOUR_KEY>`: a key is shown once, when it is made.
 */
import { useQuery } from '@tanstack/react-query'
import { SetupTabs } from '@/agents/Setup'
import { local, type Pack } from '@/api/client'
import { Mono } from '@/ui/Code'
import { CopyButton } from '@/ui/Copy'
import { Section } from '@/ui/Page'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { shortAddress } from './packs.rules'
import { packSetupQuery } from './queries'

export const AddressCard = ({ pack }: { pack: Pack }) => {
  const setup = useQuery(packSetupQuery(pack.name))
  return (
    <Section title="Address">
      {setup.isPending ? (
        <Skeleton className="h-48 rounded-none" />
      ) : setup.error ? (
        <p className="border border-border bg-card p-4 text-sm text-error">{setup.error.message}</p>
      ) : (
        <div className="flex min-w-0 flex-col border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <Mono className="min-w-0 text-sm break-all">{shortAddress(setup.data.baseUrl)}</Mono>
            <CopyButton text={setup.data.baseUrl} />
          </div>
          <p className="border-b border-border px-4 py-3 text-xs [overflow-wrap:anywhere] text-muted-foreground">
            MCP <Mono className="text-foreground">{local(setup.data.mcpUrl)}</Mono>
            {' · '}
            REST <Mono className="text-foreground">{local(setup.data.apiUrl)}</Mono>
            {' · '}
            Docs{' '}
            <a
              href={local(setup.data.docsUrl)}
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-primary"
            >
              <Mono>{local(setup.data.docsUrl)}</Mono>
            </a>
          </p>
          <div className="flex min-w-0 flex-col gap-3 p-4">
            <p className="text-sm text-muted-foreground">
              Every app connects with a key of this pack where a snippet says <Mono>{setup.data.keyPlaceholder}</Mono>.
              Give access makes one and shows it once.
            </p>
            <SetupTabs surfaces={setup.data.surfaces} keyPlaceholder={setup.data.keyPlaceholder} apiKey={null} />
          </div>
        </div>
      )}
    </Section>
  )
}
