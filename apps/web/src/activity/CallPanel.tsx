/**
 * One call, opened beside the log: what happened in words, who and which door, the arguments and the result as they
 * were (kept sealed 30 days), "Run again" in the tool's playground with the same arguments, and its Langfuse trace.
 */
import { IconPlayerPlay, IconTimeline } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ApiError } from '@/api/client'
import { Code, Mono } from '@/ui/Code'
import { bytes, duration, when } from '@/ui/format'
import { OUTCOME, Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/shadcn/sheet'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/shadcn/tabs'
import { VIA_LABEL } from './activity.rules'
import { callQuery, payloadQuery } from './queries'

const json = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2))

/** What the outcome means, said to the owner. */
const meaningOf = (status: string, error: string | null) => {
  if (status === 'ok') return 'It ran and answered.'
  if (status === 'tool_error') return `The tool ran and said no${error ? `: ${error}` : '.'} The agent got this answer.`
  if (status === 'refused') return `Yardhand stopped it before it reached the server${error ? `: ${error}` : '.'}`
  if (status === 'asked')
    return 'The server asked the agent something before going on. Its answer, if it gave one, is the next call.'
  return `The server didn't answer properly${error ? `: ${error}` : '.'} Check the connection's health.`
}

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-0.5 border-b border-border py-2.5">
    <dt className="text-xs tracking-wide text-muted-foreground uppercase">{label}</dt>
    <dd className="text-sm">{children}</dd>
  </div>
)

const Body = ({ id }: { id: string }) => {
  const call = useQuery(callQuery(id))
  const payload = useQuery(payloadQuery(id))
  if (call.isPending) return <Skeleton className="m-5 h-40 rounded-none" />
  if (call.error) return <p className="p-5 text-sm text-error">{call.error.message}</p>
  const record = call.data
  const outcome = OUTCOME[record.status] ?? { tone: 'neutral' as const, label: record.status }
  const args = payload.data?.arguments
  return (
    <div className="flex flex-col gap-5 overflow-y-auto px-5 pb-8">
      <div className="flex flex-col gap-2">
        <Status tone={outcome.tone}>{outcome.label}</Status>
        <p className="text-sm text-pretty text-muted-foreground">{meaningOf(record.status, record.error)}</p>
      </div>
      <dl className="grid grid-cols-2 gap-x-4">
        <Fact label="Agent">
          <Link to="/activity" search={{ outcome: 'all', client: record.clientId }} className="hover:underline">
            {record.clientId === 'owner' ? 'You' : record.client}
          </Link>
        </Fact>
        <Fact label="Door">{VIA_LABEL[record.via] ?? record.via}</Fact>
        <Fact label="Took">{duration(record.durationMs)}</Fact>
        <Fact label="Answer size">{bytes(record.resultBytes)}</Fact>
        <Fact label="At">{when(record.createdAt)}</Fact>
        <Fact label="Connection">
          {record.upstream ? (
            <Link to="/connections/$id" params={{ id: record.upstream }} className="hover:underline">
              {record.upstream}
            </Link>
          ) : (
            '–'
          )}
        </Fact>
      </dl>
      <Tabs defaultValue="arguments">
        <TabsList>
          <TabsTrigger value="arguments">Arguments</TabsTrigger>
          <TabsTrigger value="result">
            {record.status === 'ok' ? 'Result' : record.status === 'asked' ? 'What it asked' : 'What came back'}
          </TabsTrigger>
          {payload.data?.answers ? <TabsTrigger value="answers">Answers it went on with</TabsTrigger> : null}
        </TabsList>
        {payload.isPending ? (
          <Skeleton className="mt-3 h-32 rounded-none" />
        ) : payload.error ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {payload.error instanceof ApiError && payload.error.status === 404
              ? 'Not kept: calls older than 30 days, and calls Yardhand refused before running, keep no payload.'
              : payload.error.message}
          </p>
        ) : (
          <>
            <TabsContent value="arguments" className="mt-3">
              <Code copy>{json(payload.data.arguments ?? {})}</Code>
            </TabsContent>
            <TabsContent value="result" className="mt-3">
              <Code copy>{json(payload.data.result ?? payload.data.asked ?? payload.data.error ?? '')}</Code>
            </TabsContent>
            {payload.data.answers ? (
              <TabsContent value="answers" className="mt-3">
                <Code copy>{json(payload.data.answers)}</Code>
              </TabsContent>
            ) : null}
          </>
        )}
      </Tabs>
      <div className="flex flex-wrap gap-2">
        {record.kind === 'tool' ? (
          <Button asChild variant="primary">
            <Link
              to="/tools/$name"
              params={{ name: record.tool }}
              search={{ args: args ? JSON.stringify(args) : undefined }}
            >
              <IconPlayerPlay /> Run again
            </Link>
          </Button>
        ) : record.upstream ? (
          <Button asChild variant="primary">
            <Link
              to="/connections/$id"
              params={{ id: record.upstream }}
              search={{ tab: record.kind === 'manual' ? 'manual' : record.kind === 'playbook' ? 'playbooks' : 'links' }}
            >
              Open where it lives
            </Link>
          </Button>
        ) : null}
        <Button asChild variant="muted">
          <Link
            to="/activity"
            search={{ outcome: 'all', tool: record.tool, ...(record.kind === 'tool' ? {} : { kind: record.kind }) }}
          >
            Every <Mono className="max-w-60 truncate">{record.tool}</Mono> {record.kind === 'tool' ? 'call' : 'read'}
          </Link>
        </Button>
        {record.traceUrl ? (
          <Button asChild variant="ghost">
            <a href={record.traceUrl} target="_blank" rel="noreferrer">
              <IconTimeline /> Its trace in Langfuse
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export const CallPanel = ({ id, onClose }: { id: string | undefined; onClose: () => void }) => (
  <Sheet open={Boolean(id)} onOpenChange={(open) => !open && onClose()}>
    <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
      <SheetHeader className="border-b border-border px-5 py-4">
        <SheetTitle className="font-mono text-sm font-normal">{id ? <CallTitle id={id} /> : null}</SheetTitle>
        <SheetDescription className="font-mono text-xs">{id}</SheetDescription>
      </SheetHeader>
      {id ? <Body id={id} /> : null}
    </SheetContent>
  </Sheet>
)

const CallTitle = ({ id }: { id: string }) => {
  const call = useQuery(callQuery(id))
  return <>{call.data?.tool ?? '…'}</>
}
