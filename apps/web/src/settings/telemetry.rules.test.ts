import { describe, expect, it } from 'vitest'
import type { Schemas } from '@/api/client'
import { newerVersion, offVariable, reportGroups, timingLine, waitsForFirst } from './telemetry.rules'

const report: Schemas['UsageReport'] = {
  install: 'compose',
  arch: 'arm64',
  age: '1-7',
  https: true,
  database: '<10MB',
  claimed: true,
  connections: '1-10',
  connections_mcp: true,
  connections_http: false,
  connections_composio: false,
  tools: '11-100',
  clients_key: '1-10',
  clients_oauth: '0',
  packs: '0',
  reviews_waiting: '0',
  calls_1d: '1-10',
  calls: '11-100',
  calls_mcp: '11-100',
  calls_rest: '0',
  calls_app: '1-10',
  calls_tool_error: '0',
  calls_refused: '0',
  calls_failed: '0',
  searches: '1-10',
  clients_active: '1-10',
  meaning_search: false,
  ai_grouping: 'off',
  langfuse: false,
  discord: false,
  access_signin: false,
}
const body = { schema: 1, instance: '0b9d2c1e-1111-4222-8333-444455556666', version: '0.2.0', report }
const now = new Date('2026-11-11T12:00:00Z').getTime()
const ago = (iso: string) => `at ${iso}`

describe('the report in words', () => {
  it('shows every field sent, under its heading, with yes and no for the answers', () => {
    const groups = reportGroups(body)
    expect(groups.map((group) => group.title)).toEqual([
      'Sent with it',
      'Where it runs',
      'Setup',
      'Use over 7 days',
      'Optional parts',
    ])
    const fields = groups.flatMap((group) => group.rows.map((row) => row.field))
    expect(fields).toEqual(['instance', 'version', 'schema', ...Object.keys(report)])
    const rows = groups.flatMap((group) => group.rows)
    expect(rows.find((row) => row.field === 'https')).toEqual({
      field: 'https',
      label: 'Reached over HTTPS',
      value: 'yes',
    })
    expect(rows.find((row) => row.field === 'connections_http')?.value).toBe('no')
    expect(rows.find((row) => row.field === 'tools')?.value).toBe('11-100')
  })

  it('never drops a field it has no words for', () => {
    const groups = reportGroups({ ...body, report: { ...report, something_new: '1-10' } as Schemas['UsageReport'] })
    expect(groups.at(-1)).toEqual({
      title: 'Other',
      rows: [{ field: 'something_new', label: 'something_new', value: '1-10' }],
    })
  })
})

describe('when it goes', () => {
  const waiting = { on: true, off: null, sent: null, firstAt: '2026-11-12T09:00:00Z' }

  it('waits a day before the first report, and says how long is left', () => {
    expect(waitsForFirst(waiting, now)).toBe(true)
    expect(timingLine(waiting, ago, now)).toBe(
      'Nothing has been sent yet. The first report goes in 21 h, a day after this instance first ran with telemetry.',
    )
    expect(timingLine({ ...waiting, firstAt: '2026-11-11T12:20:00Z' }, ago, now)).toMatch(/goes in 20 min,/)
  })

  it('says the first goes with the next run once the day is over', () => {
    const due = { ...waiting, firstAt: '2026-11-11T09:00:00Z' }
    expect(waitsForFirst(due, now)).toBe(false)
    expect(timingLine(due, ago, now)).toBe('Nothing has been sent yet. The first report goes with the next daily run.')
  })

  it('says when the last one went', () => {
    const sent = { ...waiting, sent: { at: '2026-11-11T09:00:00Z', body } }
    expect(waitsForFirst(sent, now)).toBe(false)
    expect(timingLine(sent, ago, now)).toBe('The last report went at 2026-11-11T09:00:00Z. The next goes within a day.')
  })

  it('names the variable that switched it off, and never waits', () => {
    const off = { ...waiting, on: false, off: 'DO_NOT_TRACK is set' }
    expect(waitsForFirst(off, now)).toBe(false)
    expect(offVariable('DO_NOT_TRACK is set')).toBe('DO_NOT_TRACK')
    expect(offVariable('GATEWAY_TELEMETRY is off')).toBe('GATEWAY_TELEMETRY')
    expect(timingLine(off, ago, now)).toBe('Nothing is sent: DO_NOT_TRACK is set in this instance’s environment.')
    expect(timingLine({ ...off, off: 'GATEWAY_TELEMETRY is off' }, ago, now)).toBe(
      'Nothing is sent: GATEWAY_TELEMETRY is off in this instance’s environment.',
    )
  })
})

describe('a newer version', () => {
  it('is named only when it is newer than the one running', () => {
    expect(newerVersion('0.3.0', '0.2.0')).toBe('0.3.0')
    expect(newerVersion('v0.2.1', '0.2.0')).toBe('0.2.1')
    expect(newerVersion('0.10.0', '0.9.4')).toBe('0.10.0')
    expect(newerVersion('0.2.0', '0.2.0')).toBeNull()
    expect(newerVersion('0.1.9', '0.2.0')).toBeNull()
    expect(newerVersion(null, '0.2.0')).toBeNull()
  })

  it('ignores an answer that is not a version', () => {
    expect(newerVersion('<b>new</b>', '0.2.0')).toBeNull()
    expect(newerVersion('latest', '0.2.0')).toBeNull()
    expect(newerVersion('1.0', '0.2.0')).toBeNull()
  })
})
