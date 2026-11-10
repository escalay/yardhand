/**
 * Every call in Langfuse, metadata only: who, which tool and upstream, which door, how it ended, how long and
 * how big. Never arguments or results (those stay sealed in the gateway). Batched in the background; a Langfuse outage
 * drops traces, never calls.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

/** The caller's W3C trace context: its trace and the span the call happened in. */
export type TraceParent = { traceId: string; parentId: string }

const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/

/** A `traceparent` (`00-<trace id>-<span id>-<flags>`), or null when absent, malformed or all zeros. */
export const parseTraceparent = (value: string | null | undefined): TraceParent | null => {
  const match = value ? TRACEPARENT.exec(value.trim().toLowerCase()) : null
  if (!match?.[1] || !match[2] || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null
  return { traceId: match[1], parentId: match[2] }
}

/** Where a call's trace opens: the caller's trace at the call's span, or the call's own trace. */
export const traceUrlOf = (tracesUrl: string | null, call: { id: string; traceId: string | null }) =>
  tracesUrl ? (call.traceId ? `${tracesUrl}/${call.traceId}?observation=${call.id}` : `${tracesUrl}/${call.id}`) : null

/** The trace context of the request being served: set once per `/api` request, read where calls are recorded. */
export const traceContext = new AsyncLocalStorage<TraceParent | null>()

export type CallTrace = {
  callId: string
  client: string
  tool: string
  upstream: string | null
  via: string
  status: string
  durationMs: number
  resultBytes: number
  at: string
  /** The caller's trace: the call becomes a span in it. Without one, it is a trace of its own. */
  parent?: TraceParent | null
}

const metadataOf = (trace: CallTrace) => ({
  tool: trace.tool,
  upstream: trace.upstream,
  via: trace.via,
  status: trace.status,
  durationMs: trace.durationMs,
  resultBytes: trace.resultBytes,
  client: trace.client,
})

/** A call with the caller's trace context is a span in the caller's trace; one without is a trace of its own. */
export const eventOf = (trace: CallTrace) =>
  trace.parent
    ? {
        id: randomUUID(),
        timestamp: trace.at,
        type: 'span-create',
        body: {
          id: trace.callId,
          traceId: trace.parent.traceId,
          parentObservationId: trace.parent.parentId,
          name: `gateway ${trace.tool}`,
          startTime: new Date(Date.parse(trace.at) - trace.durationMs).toISOString(),
          endTime: trace.at,
          environment: 'yardhand',
          level: trace.status === 'ok' ? 'DEFAULT' : trace.status === 'tool_error' ? 'WARNING' : 'ERROR',
          ...(trace.status === 'ok' ? {} : { statusMessage: trace.status }),
          metadata: metadataOf(trace),
        },
      }
    : {
        id: randomUUID(),
        timestamp: trace.at,
        type: 'trace-create',
        body: {
          id: trace.callId,
          name: `call ${trace.tool}`,
          timestamp: trace.at,
          userId: trace.client,
          environment: 'yardhand',
          tags: [trace.upstream ?? 'none', trace.status, trace.via],
          metadata: metadataOf(trace),
        },
      }

const FLUSH_MS = 5000
const MAX_QUEUE = 1000

export const createTraceSender = ({
  baseUrl,
  publicKey,
  secretKey,
  fetchImpl = fetch,
  log = (message: string) => console.warn(message),
}: {
  baseUrl: string
  publicKey: string
  secretKey: string
  fetchImpl?: typeof fetch
  log?: (message: string) => void
}) => {
  let queue: CallTrace[] = []
  const flush = async () => {
    if (!queue.length) return
    const batch = queue
    queue = []
    const body = { batch: batch.map(eventOf) }
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) => {
      log(`traces: ${batch.length} dropped (${error instanceof Error ? error.message : String(error)})`)
      return null
    })
    if (response && !response.ok && response.status !== 207) log(`traces: Langfuse answered ${response.status}`)
  }
  const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`
  let project: Promise<string | null> | null = null
  /** The Langfuse project these keys write to (asked once; null when Langfuse doesn't say). */
  const projectId = () => {
    project ??= fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/public/projects`, {
      headers: { authorization: auth },
      signal: AbortSignal.timeout(5000),
    })
      .then(async (response) =>
        response.ok ? (((await response.json()) as { data?: { id: string }[] }).data?.[0]?.id ?? null) : null,
      )
      .catch(() => null)
      .then((id) => {
        if (!id) project = null
        return id
      })
    return project
  }
  const timer = setInterval(() => void flush(), FLUSH_MS)
  timer.unref()
  return {
    send: (trace: CallTrace) => {
      if (queue.length < MAX_QUEUE) queue.push(trace)
    },
    flush,
    /** Where this project's traces open in Langfuse, or null when Langfuse doesn't say which project. */
    tracesUrl: async () => {
      const id = await projectId()
      return id ? `${baseUrl.replace(/\/$/, '')}/project/${id}/traces` : null
    },
    stop: () => clearInterval(timer),
  }
}

export type TraceSender = ReturnType<typeof createTraceSender>
