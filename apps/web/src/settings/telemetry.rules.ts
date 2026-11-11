/** Pure rules for usage telemetry in Settings, the setup and Home: the report in plain words, and when it goes. */
import type { Schemas } from '@/api/client'

type Telemetry = Schemas['Telemetry']
type Report = Schemas['UsageReport']
type Field = keyof Report

export const DOC_URL = 'https://github.com/escalay/yardhand/blob/main/docs/telemetry.md'
export const OFF_LINE = 'GATEWAY_TELEMETRY=off'

/** Every field of the report under its heading, in the order shown; a new field fails the typecheck until it is here. */
const LABELS: Record<Field, { group: Group; label: string }> = {
  install: { group: 'Where it runs', label: 'How it was installed' },
  arch: { group: 'Where it runs', label: 'Processor' },
  age: { group: 'Where it runs', label: 'Days since it first could report' },
  https: { group: 'Where it runs', label: 'Reached over HTTPS' },
  database: { group: 'Where it runs', label: 'Database size' },
  claimed: { group: 'Setup', label: 'Has an owner' },
  connections: { group: 'Setup', label: 'Connections' },
  connections_mcp: { group: 'Setup', label: 'An MCP server is connected' },
  connections_http: { group: 'Setup', label: 'A REST API is connected' },
  connections_composio: { group: 'Setup', label: 'Composio is connected' },
  tools: { group: 'Setup', label: 'Tools' },
  clients_key: { group: 'Setup', label: 'Agents with a key' },
  clients_oauth: { group: 'Setup', label: 'Agents signed in with OAuth' },
  packs: { group: 'Setup', label: 'Packs' },
  reviews_waiting: { group: 'Setup', label: 'Changes waiting for review' },
  calls_1d: { group: 'Use over 7 days', label: 'Calls in the last day' },
  calls: { group: 'Use over 7 days', label: 'Calls' },
  calls_mcp: { group: 'Use over 7 days', label: 'Calls over MCP' },
  calls_rest: { group: 'Use over 7 days', label: 'Calls over REST' },
  calls_app: { group: 'Use over 7 days', label: 'Calls from this app' },
  calls_tool_error: { group: 'Use over 7 days', label: 'Calls a tool answered with an error' },
  calls_refused: { group: 'Use over 7 days', label: 'Calls refused' },
  calls_failed: { group: 'Use over 7 days', label: 'Calls a server failed' },
  searches: { group: 'Use over 7 days', label: 'Tool searches' },
  clients_active: { group: 'Use over 7 days', label: 'Agents that called' },
  meaning_search: { group: 'Optional parts', label: 'Search by meaning' },
  ai_grouping: { group: 'Optional parts', label: 'Smart grouping' },
  langfuse: { group: 'Optional parts', label: 'Call traces in Langfuse' },
  discord: { group: 'Optional parts', label: 'Review alerts on Discord' },
  access_signin: { group: 'Optional parts', label: 'Sign-in by Cloudflare Access' },
}

const GROUPS = ['Where it runs', 'Setup', 'Use over 7 days', 'Optional parts'] as const
type Group = (typeof GROUPS)[number]

const said = (value: unknown) => (value === true ? 'yes' : value === false ? 'no' : String(value))

export type ReportGroup = { title: string; rows: { field: string; label: string; value: string }[] }

/**
 * The report as headed lists of label and value. Nothing sent is left out: a field without a label here shows under
 * its own name, and what travels beside the report (the id, the version, the schema number) comes first.
 */
export const reportGroups = (body: Schemas['UsageReportBody']): ReportGroup[] => {
  const fields = Object.entries(body.report) as [string, unknown][]
  const known = (field: string): field is Field => field in LABELS
  const rowsOf = (group: Group) =>
    fields
      .filter(([field]) => known(field) && LABELS[field].group === group)
      .map(([field, value]) => ({ field, label: LABELS[field as Field].label, value: said(value) }))
  const unnamed = fields
    .filter(([field]) => !known(field))
    .map(([field, value]) => ({ field, label: field, value: said(value) }))
  return [
    {
      title: 'Sent with it',
      rows: [
        { field: 'instance', label: 'A random id for this instance', value: body.instance },
        { field: 'version', label: 'Yardhand version', value: body.version },
        { field: 'schema', label: 'Field list number', value: String(body.schema) },
      ],
    },
    ...GROUPS.map((title) => ({ title, rows: rowsOf(title) })),
    ...(unnamed.length ? [{ title: 'Other', rows: unnamed }] : []),
  ].filter((group) => group.rows.length)
}

/** Which variable switched it off, from the server's reason. */
export const offVariable = (off: string | null) =>
  off?.startsWith('DO_NOT_TRACK') ? 'DO_NOT_TRACK' : 'GATEWAY_TELEMETRY'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Whether the first report is still to come: on, nothing sent yet, and the day's wait not over. */
export const waitsForFirst = (view: Pick<Telemetry, 'on' | 'sent' | 'firstAt'>, now = Date.now()) =>
  view.on && !view.sent && new Date(view.firstAt).getTime() > now

/** "in 21 h", "in 12 min". */
const inLine = (iso: string, now: number) => {
  const ms = new Date(iso).getTime() - now
  return ms < HOUR ? `in ${Math.max(1, Math.round(ms / MINUTE))} min` : `in ${Math.round(ms / HOUR)} h`
}

/** When a report goes or went, in a sentence. `ago` is the app's own way of saying a past time. */
export const timingLine = (
  view: Pick<Telemetry, 'on' | 'off' | 'sent' | 'firstAt'>,
  ago: (iso: string) => string,
  now = Date.now(),
) => {
  if (!view.on) {
    const variable = offVariable(view.off)
    return `Nothing is sent: ${variable} is ${variable === 'DO_NOT_TRACK' ? 'set' : 'off'} in this instance’s environment.`
  }
  if (view.sent) return `The last report went ${ago(view.sent.at)}. The next goes within a day.`
  return waitsForFirst(view, now)
    ? `Nothing has been sent yet. The first report goes ${inLine(view.firstAt, now)}, a day after this instance first ran with telemetry.`
    : 'Nothing has been sent yet. The first report goes with the next daily run.'
}

const parts = (version: string) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim())
  return match ? match.slice(1, 4).map(Number) : null
}

/** The newest release when it is newer than the one running (`major.minor.patch`; anything else is ignored). */
export const newerVersion = (latest: string | null, running: string) => {
  const [newest, mine] = [latest ? parts(latest) : null, parts(running)]
  if (!latest || !newest || !mine) return null
  for (let index = 0; index < 3; index++) {
    const difference = (newest[index] ?? 0) - (mine[index] ?? 0)
    if (difference) return difference > 0 ? latest.trim().replace(/^v/, '') : null
  }
  return null
}
