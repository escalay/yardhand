import { describe, expect, it } from 'vitest'
import type { Schemas } from '@/api/client'
import { autoBlocked, follows, headlineOf, howLine, noticeOf, reloadsAfter } from './updates.rules'

type Run = Schemas['UpdateRun']

const run = (given: Partial<Run> = {}): Run => ({
  id: 'run-1',
  state: 'done',
  step: 'Done',
  from: '0.2.0',
  to: '0.3.0',
  startedAt: '2026-11-10T10:00:00.000Z',
  at: '2026-11-10T10:01:00.000Z',
  detail: null,
  ...given,
})
const latest = (version: string) => ({
  version,
  checkedAt: '2026-11-11T08:00:00.000Z',
  notes: `https://github.com/escalay/yardhand/releases/tag/v${version}`,
})
const view = (given: Partial<Parameters<typeof headlineOf>[0]> = {}) => ({
  current: '0.2.0',
  latest: latest('0.3.0'),
  newer: true,
  status: null,
  ...given,
})

describe('the headline', () => {
  it('says a newer version is out, and which one runs', () => {
    expect(headlineOf(view())).toEqual({
      kind: 'available',
      title: 'Yardhand 0.3.0 is available',
      line: 'This is 0.2.0.',
    })
  })

  it('says when this is the newest, and when nobody has asked yet', () => {
    expect(headlineOf(view({ latest: latest('0.2.0'), newer: false })).line).toBe('This is the newest version.')
    expect(headlineOf(view({ latest: null, newer: false })).line).toBe('No check for a newer version has run yet.')
  })

  it('follows a run under way, step by step', () => {
    const headline = headlineOf(view({ status: run({ state: 'working', step: 'Checking the release’s signature' }) }))
    expect(headline.kind).toBe('working')
    expect(headline.title).toBe('Updating to 0.3.0')
    expect(headline.line).toMatch(/^Checking the release’s signature\. Yardhand restarts/)
  })

  it('says a failed update was put back, and why', () => {
    expect(headlineOf(view({ status: run({ state: 'failed', detail: 'It never answered as 0.3.0' }) }))).toEqual({
      kind: 'failed',
      title: 'The update to 0.3.0 failed and 0.2.0 was put back',
      line: 'It never answered as 0.3.0',
    })
    expect(headlineOf(view({ status: run({ state: 'refused', detail: 'The signature didn’t check' }) }))).toEqual({
      kind: 'refused',
      title: 'The update was refused',
      line: 'The signature didn’t check',
    })
  })

  it('goes back to what is available once a newer version than the failed one is out', () => {
    const headline = headlineOf(view({ latest: latest('0.3.1'), status: run({ state: 'failed' }) }))
    expect(headline).toMatchObject({ kind: 'available', title: 'Yardhand 0.3.1 is available' })
  })

  it('says nothing more about an update that worked: the version says it', () => {
    expect(headlineOf(view({ current: '0.3.0', newer: false, status: run() }))).toMatchObject({
      kind: 'current',
      title: 'Yardhand 0.3.0',
    })
  })
})

describe('automatic updates', () => {
  it('need the updater to be switched on, and can always be switched off', () => {
    expect(autoBlocked({ updater: { present: true, version: '1.0.0' }, auto: false })).toBeNull()
    expect(autoBlocked({ updater: { present: false, version: null }, auto: false })).toMatch(/Needs the updater/)
    expect(autoBlocked({ updater: { present: false, version: null }, auto: true })).toBeNull()
  })
})

describe('update now', () => {
  it('says what it does here, and nothing where the owner runs the commands', () => {
    expect(howLine('updater')).toMatch(/signature[\s\S]*backs up[\s\S]*puts the old one back/)
    expect(howLine('hook')).toMatch(/deploy hook/)
    expect(howLine('manual')).toBeNull()
  })
})

describe('following a run', () => {
  it('keeps asking while it works, and from the click until the updater answers', () => {
    const now = 1_000_000
    const asked = (before: string | null) => ({ before, at: now - 5000 })
    expect(follows(run({ state: 'working' }), null, now)).toBe(true)
    expect(follows(run(), null, now)).toBe(false)
    expect(follows(null, asked(null), now)).toBe(true)
    expect(follows(run({ id: 'old' }), asked('old'), now)).toBe(true)
    expect(follows(run({ id: 'new', state: 'refused' }), asked('old'), now)).toBe(false)
    // An updater that never takes the request isn't waited for forever
    expect(follows(null, { before: null, at: now - 3 * 60_000 }, now)).toBe(false)
  })

  it('loads the new app once, only for a run this page watched', () => {
    expect(reloadsAfter(true, run())).toBe(true)
    expect(reloadsAfter(false, run())).toBe(false)
    expect(reloadsAfter(true, run({ state: 'failed' }))).toBe(false)
    // The earlier run's good end is still on screen right after the click for the next one
    expect(reloadsAfter(true, run({ id: 'run-1' }), 'run-1')).toBe(false)
    expect(reloadsAfter(true, run({ id: 'run-2' }), 'run-1')).toBe(true)
  })
})

describe('the notice on Home', () => {
  it('shows only while a newer version waits', () => {
    expect(noticeOf(view())).toMatchObject({ version: '0.3.0', current: '0.2.0' })
    expect(noticeOf(view({ newer: false }))).toBeNull()
    expect(noticeOf(view({ status: run({ state: 'working' }) }))).toBeNull()
  })
})
