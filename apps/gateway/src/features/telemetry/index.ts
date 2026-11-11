/**
 * Usage telemetry (docs/telemetry.md): once a day this instance sends an anonymous report, unless it is switched off
 * with `GATEWAY_TELEMETRY=off` or `DO_NOT_TRACK=1`. A new instance, and one that just upgraded to a version with
 * telemetry, waits a day first, so its owner reads the notice before anything leaves. A failed send is dropped.
 */
import { randomUUID } from 'node:crypto'
import { VERSION } from '../../version.js'
import { buildReport, type Facts, type Report, SCHEMA, type Source } from './report.js'

export const DEFAULT_URL = 'https://pulse.escalay.space/v1/yardhand'
const WAIT_MS = 24 * 60 * 60 * 1000
const SEND_TIMEOUT_MS = 5000

type TelemetryEnv = { GATEWAY_TELEMETRY?: string; GATEWAY_TELEMETRY_URL?: string; DO_NOT_TRACK?: string }

/** Why telemetry is off, or null when it is on. */
export const offReason = (env: TelemetryEnv) =>
  /^(1|true)$/i.test(env.DO_NOT_TRACK ?? '')
    ? 'DO_NOT_TRACK is set'
    : /^(off|false|0|no)$/i.test(env.GATEWAY_TELEMETRY ?? '')
      ? 'GATEWAY_TELEMETRY is off'
      : null

/** A random id that says nothing about the instance, and when it first could report. */
type Kept = { id: string; since: string }
/** The last report sent, as it was sent, for Settings; and the newest release the answer named. */
export type Sent = { at: string; body: { schema: number; instance: string; version: string; report: Report } }

const KEPT = 'telemetry'
const SENT = 'telemetry:sent'
const LATEST = 'telemetry:latest'

export const createTelemetry = (
  services: Source & {
    vault: { get: <T>(name: string) => Promise<T | undefined>; put: (name: string, value: unknown) => Promise<unknown> }
  },
  facts: () => Omit<Facts, 'since'>,
  fetchImpl: typeof fetch = fetch,
) => {
  const { vault } = services
  const env = services.env as TelemetryEnv
  const url = env.GATEWAY_TELEMETRY_URL || DEFAULT_URL
  const kept = async (now: Date) => {
    const before = await vault.get<Kept>(KEPT)
    if (before) return before
    const made = { id: randomUUID(), since: now.toISOString() }
    await vault.put(KEPT, made)
    return made
  }
  const bodyOf = async (now: Date) => {
    const { id, since } = await kept(now)
    const report = await buildReport(services, { ...facts(), since }, now)
    return { since, body: { schema: SCHEMA, instance: id, version: VERSION, report } }
  }
  return {
    /** The daily job: says what it did, in a sentence Settings shows. */
    send: async (now = new Date()) => {
      const off = offReason(env)
      if (off) return `Off: ${off}`
      const { since, body } = await bodyOf(now)
      const first = new Date(new Date(since).getTime() + WAIT_MS)
      if (now < first) return `Waiting: the first report goes after ${first.toISOString()}`
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`The report was answered ${response.status}`)
      await vault.put(SENT, { at: now.toISOString(), body } satisfies Sent)
      const answer = (await response.json().catch(() => null)) as { latest?: unknown } | null
      if (typeof answer?.latest === 'string') await vault.put(LATEST, answer.latest)
      return 'Sent'
    },
    /** For Settings: whether it is on, where it sends, what it would send now and what it last sent. */
    view: async (now = new Date()) => {
      const off = offReason(env)
      const { since, body } = await bodyOf(now)
      return {
        on: !off,
        off,
        url,
        firstAt: new Date(new Date(since).getTime() + WAIT_MS).toISOString(),
        next: body,
        sent: (await vault.get<Sent>(SENT)) ?? null,
        latest: (await vault.get<string>(LATEST)) ?? null,
      }
    },
  }
}

export type Telemetry = ReturnType<typeof createTelemetry>
