/**
 * Usage telemetry in Settings: whether the daily report is on, where it goes, when, and the report itself, field by
 * field and as the JSON that is posted. It is switched off where the instance runs, so there is no switch here.
 */
import { IconChevronDown } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { Schemas } from '@/api/client'
import { telemetryQuery } from '@/shell/queries'
import { Code, Mono } from '@/ui/Code'
import { ago } from '@/ui/format'
import { Status } from '@/ui/Status'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/shadcn/collapsible'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { SettingsCard, SettingsGroup } from './SettingsGroup'
import { DOC_URL, newerVersion, OFF_LINE, offVariable, reportGroups, timingLine } from './telemetry.rules'

export const TELEMETRY_ID = 'usage-telemetry'

const Json = ({ title, body }: { title: string; body: Schemas['UsageReportBody'] }) => (
  <Collapsible className="px-5 py-3">
    <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 text-left text-sm text-muted-foreground hover:text-foreground">
      {title}
      <IconChevronDown className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
    <CollapsibleContent className="pt-3">
      <Code copy label="application/json">
        {JSON.stringify(body, null, 2)}
      </Code>
    </CollapsibleContent>
  </Collapsible>
)

const Card = ({ view }: { view: Schemas['Telemetry'] }) => {
  const newer = newerVersion(view.latest, view.next.version)
  return (
    <>
      <SettingsCard>
        <div className="flex items-start justify-between gap-4 px-5 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm font-medium">The daily report</span>
            <span className="text-sm text-pretty text-muted-foreground">{timingLine(view, ago)}</span>
          </div>
          <Status tone={view.on ? 'ok' : 'neutral'}>{view.on ? 'On' : 'Off'}</Status>
        </div>
        <div className="flex min-w-0 flex-col gap-1 px-5 py-4">
          <span className="text-sm font-medium">{view.on ? 'Where it goes' : 'Where it would go'}</span>
          <Mono className="text-[13px] break-all text-muted-foreground">{view.url}</Mono>
        </div>
        {newer ? (
          <p className="px-5 py-4 text-sm text-pretty">
            A newer version is out: <Mono>{newer}</Mono>. <span className="text-muted-foreground">This is </span>
            <Mono className="text-muted-foreground">{view.next.version}</Mono>
            <span className="text-muted-foreground">; the answer to the last report named it.</span>
          </p>
        ) : null}
        <div className="flex flex-col gap-3 px-5 py-4">
          {view.on ? (
            <>
              <p className="text-sm text-pretty text-muted-foreground">
                To switch it off, add this line to .env and restart Yardhand. There is no switch here on purpose: it is
                set where the instance runs, so nothing in the app can turn it back on.
              </p>
              <Code copy label=".env">
                {OFF_LINE}
              </Code>
            </>
          ) : (
            <p className="text-sm text-pretty text-muted-foreground">
              It stays off while <Mono>{offVariable(view.off)}</Mono> is set where this instance runs. To send reports
              again, take that line out of .env and restart Yardhand.
            </p>
          )}
          <p className="text-sm text-pretty text-muted-foreground">
            {view.on ? (
              <>
                <Mono>DO_NOT_TRACK=1</Mono> does the same.{' '}
              </>
            ) : null}
            What every field means, and what is never sent:{' '}
            <a href={DOC_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              docs/telemetry.md
            </a>
            .
          </p>
        </div>
      </SettingsCard>
      <SettingsCard>
        <p className="px-5 py-4 text-sm text-pretty text-muted-foreground">
          <span className="font-medium text-foreground">
            {view.on ? 'The report it would send now' : 'The report it would send, were it on'}
          </span>
          <br />
          All of it: ranges and yes/no answers. No name, address, query or key is in it.
        </p>
        {reportGroups(view.next).map((group) => (
          <div key={group.title} className="flex flex-col gap-2 px-5 py-4">
            <h3 className="text-xs tracking-wide text-muted-foreground uppercase">{group.title}</h3>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
              {group.rows.map((row) => (
                <div key={row.field} className="flex min-w-0 items-baseline justify-between gap-4" title={row.field}>
                  <dt className="min-w-0 text-pretty text-muted-foreground">{row.label}</dt>
                  <dd className="min-w-0 text-right font-mono text-[13px] break-all">{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
        <Json title="See it as the JSON that is posted" body={view.next} />
        {view.sent ? <Json title={`See the last one sent, ${ago(view.sent.at)}`} body={view.sent.body} /> : null}
      </SettingsCard>
    </>
  )
}

export const Telemetry = () => {
  const telemetry = useQuery(telemetryQuery)
  // Home and the setup link straight to this group
  useEffect(() => {
    if (location.hash === `#${TELEMETRY_ID}`) document.getElementById(TELEMETRY_ID)?.scrollIntoView()
  }, [])
  return (
    <SettingsGroup
      id={TELEMETRY_ID}
      title="Usage telemetry"
      description="Once a day, one anonymous report of how far this instance is set up and how much it is used. Everything in it is shown here."
    >
      {telemetry.isPending ? (
        <Skeleton className="h-40 rounded-none" />
      ) : telemetry.error ? (
        <SettingsCard>
          <p className="px-5 py-4 text-sm text-muted-foreground">{telemetry.error.message}</p>
        </SettingsCard>
      ) : (
        <Card view={telemetry.data} />
      )}
    </SettingsGroup>
  )
}
