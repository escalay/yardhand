/**
 * Settings: the gateway itself, as groups on two lines (what a group is for on the left, its card on the right): AI,
 * where agents and scripts find it, which optional parts are on (and how to turn one on), what runs, the usage
 * report, live sync, backups, and the settings as one JSON file to export or bring back.
 */
import { IconDownload, IconUpload } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'
import { toast } from 'sonner'
import { api, unwrap } from '@/api/client'
import { systemQuery } from '@/shell/queries'
import { Code } from '@/ui/Code'
import { ago, bytes, plural } from '@/ui/format'
import { Page, PageHeader } from '@/ui/Page'
import { Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { AiSection } from './AiSection'
import { Backups } from './Backups'
import { Jobs } from './Jobs'
import { versionLine } from './jobs.rules'
import { SettingsCard, SettingsCells, SettingsGroup } from './SettingsGroup'
import { Telemetry } from './Telemetry'

const FEATURES = {
  meaningSearch: {
    title: 'Search by meaning',
    on: 'Tools are found by what they do, not only their words.',
    off: 'Keyword search only. Give it a key under AI, or set OPENROUTER_API_KEY.',
  },
  oauth: {
    title: 'OAuth for agents',
    on: 'claude.ai and other connectors can sign in and ask for your approval.',
    off: 'Only keys. Set OAUTH_SIGNING_KEY so claude.ai can connect.',
  },
  access: {
    title: 'Cloudflare Access',
    on: 'Cloudflare signs you in before this app loads.',
    off: 'You sign in here with an owner key (this deploy has no Access in front).',
  },
  alerts: {
    title: 'Review alerts on Discord',
    on: 'Tool changes waiting for review are posted to Discord.',
    off: 'Set DISCORD_WEBHOOK_URL to hear about tool changes.',
  },
  traces: {
    title: 'Call traces in Langfuse',
    on: 'Every call’s metadata (never its arguments or results) goes to Langfuse.',
    off: 'Set GATEWAY_LANGFUSE_* to trace calls.',
  },
} as const

const LIVE = {
  listening: { tone: 'ok', label: 'listening' },
  reconnecting: { tone: 'warn', label: 'reconnecting' },
  quiet: { tone: 'neutral', label: 'hourly' },
} as const

/** "11 listen for changes; 3 are covered by the hourly sync." */
const liveLine = (entries: { state: keyof typeof LIVE }[]) => {
  const quiet = entries.filter((entry) => entry.state === 'quiet').length
  const live = entries.length - quiet
  return `${live} ${live === 1 ? 'listens' : 'listen'} for changes${quiet ? `; ${quiet} ${quiet === 1 ? 'is' : 'are'} covered by the hourly sync` : ''}.`
}

export const SettingsPage = () => {
  const queries = useQueryClient()
  const system = useQuery(systemQuery)
  const file = useRef<HTMLInputElement>(null)
  const exportConfig = useMutation({
    mutationFn: () => unwrap(api.GET('/api/config')),
    onSuccess: (config) => {
      const link = document.createElement('a')
      link.href = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }))
      link.download = `yardhand-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      URL.revokeObjectURL(link.href)
    },
    onError: (error) => toast.error(error.message),
  })
  const importConfig = useMutation({
    mutationFn: async (picked: File) => unwrap(api.POST('/api/config', { body: JSON.parse(await picked.text()) })),
    onSuccess: (result) => {
      toast.success(
        `Imported: ${plural(result.created.length, 'connection')} added, ${result.kept.length} kept, ${plural(result.pins, 'pin')}${result.skipped.length ? `; skipped: ${result.skipped.join(', ')}` : ''}.`,
      )
      void queries.invalidateQueries()
    },
    onError: (error) =>
      toast.error(error instanceof SyntaxError ? 'That file is not a gateway export (not JSON).' : error.message),
  })

  const data = system.data
  // The browser is on the gateway's own address, whatever PUBLIC_HOST says
  const origin = location.origin
  return (
    <Page>
      <PageHeader
        label="Settings"
        title={
          <>
            Yardhand <em>itself</em>
          </>
        }
      />
      {system.isPending ? (
        <Skeleton className="h-64 rounded-none" />
      ) : system.error ? (
        <p className="text-sm text-error">{system.error.message}</p>
      ) : data ? (
        <div className="flex flex-col gap-8">
          <AiSection />
          <SettingsGroup
            title="Where agents find it"
            description="One address for agents over MCP, one for scripts over REST."
          >
            <SettingsCard>
              <div className="flex flex-col gap-3 p-5">
                <Code copy label="MCP">{`${origin}/mcp`}</Code>
                <Code copy label="REST">{`${origin}/api`}</Code>
              </div>
              <p className="px-5 py-4 text-sm text-muted-foreground">
                Agents read the guide at{' '}
                <a href="/llms.txt" className="underline underline-offset-4">
                  /llms.txt
                </a>
                , the full API is at{' '}
                <a href="/docs" className="underline underline-offset-4">
                  /docs
                </a>
                , and every tool is an OpenAPI operation at <span className="font-mono">/api/tools/openapi.json</span>.
              </p>
            </SettingsCard>
          </SettingsGroup>
          <SettingsGroup title="Optional parts" description="Each turns on with its variable in .env; off says which.">
            <SettingsCard>
              {(Object.keys(FEATURES) as (keyof typeof FEATURES)[]).map((key) => (
                <div key={key} className="flex items-start justify-between gap-4 px-5 py-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-medium">{FEATURES[key].title}</span>
                    <span className="text-sm text-muted-foreground">
                      {data.features[key] ? FEATURES[key].on : FEATURES[key].off}
                    </span>
                  </div>
                  <Status tone={data.features[key] ? 'ok' : 'neutral'}>{data.features[key] ? 'On' : 'Off'}</Status>
                </div>
              ))}
            </SettingsCard>
          </SettingsGroup>
          <SettingsGroup
            title="Running"
            description="This deploy, and the jobs it runs by itself. Their runs are remembered across restarts."
          >
            <SettingsCells className="grid-cols-2 sm:grid-cols-4">
              {[
                ['Version', versionLine(data.version, data.build)],
                ['Node', data.node],
                ['Up since', ago(data.startedAt)],
                ['Database', bytes(data.database.bytes)],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-col gap-1 px-5 py-4">
                  <span className="text-xs tracking-wide text-muted-foreground uppercase">{label}</span>
                  <span className="font-mono text-sm">{value}</span>
                </div>
              ))}
            </SettingsCells>
            <Jobs jobs={data.jobs} />
          </SettingsGroup>
          <Telemetry />
          {data.liveSync.length ? (
            <SettingsGroup title="Live sync" description={liveLine(data.liveSync)}>
              <SettingsCells className="sm:grid-cols-2 xl:grid-cols-3">
                {data.liveSync.map((entry) => (
                  <div key={entry.upstream} className="flex min-w-0 flex-col gap-0.5 px-5 py-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-[13px]">{entry.upstream}</span>
                      <Status tone={LIVE[entry.state].tone}>{LIVE[entry.state].label}</Status>
                    </div>
                    <span className="truncate text-xs text-muted-foreground" title={entry.error ?? undefined}>
                      {entry.state === 'quiet'
                        ? 'Covered by the hourly sync'
                        : entry.state === 'reconnecting' && entry.error
                          ? entry.error
                          : entry.lastChangeAt
                            ? `Last change ${ago(entry.lastChangeAt)}`
                            : `Since ${ago(entry.since)}`}
                    </span>
                  </div>
                ))}
              </SettingsCells>
            </SettingsGroup>
          ) : null}
          <SettingsGroup
            title="Backups"
            description="A copy of the database every day; the last seven stay in the state folder. Download one, or restore Yardhand from one."
          >
            <Backups backups={data.backups} />
          </SettingsGroup>
          <SettingsGroup
            title="Settings as a file"
            description="Connections, agents, pins and tool settings as JSON, without any key or secret."
          >
            <SettingsCard>
              <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                <p className="max-w-md text-sm text-muted-foreground">
                  Bring it into another gateway, then give the connections that need one their keys again.
                </p>
                <div className="flex gap-2">
                  <Button variant="muted" onClick={() => exportConfig.mutate()} disabled={exportConfig.isPending}>
                    <IconDownload /> Export
                  </Button>
                  <Button variant="ghost" onClick={() => file.current?.click()} disabled={importConfig.isPending}>
                    <IconUpload /> {importConfig.isPending ? 'Importing…' : 'Import'}
                  </Button>
                  <input
                    ref={file}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(event) => {
                      const picked = event.target.files?.[0]
                      if (picked) importConfig.mutate(picked)
                      event.target.value = ''
                    }}
                  />
                </div>
              </div>
            </SettingsCard>
          </SettingsGroup>
        </div>
      ) : null}
    </Page>
  )
}
