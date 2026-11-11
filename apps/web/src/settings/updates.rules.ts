/** Pure rules for updates in Settings and on Home: what to say about the version running, the newest, and a run. */
import type { Schemas } from '@/api/client'

type Updates = Schemas['Updates']
type Run = Schemas['UpdateRun']

export const UPDATES_ID = 'updates'
export const POLL_MS = 3000

/** What the top of the card says: a run under way or just ended wins over a newer version being out. */
export type Headline =
  | { kind: 'working'; title: string; line: string }
  | { kind: 'done' | 'failed' | 'refused'; title: string; line: string | null }
  | { kind: 'available'; title: string; line: string }
  | { kind: 'current'; title: string; line: string }

const outcomeLine = (run: Run): Headline => {
  if (run.state === 'working')
    return {
      kind: 'working',
      title: `Updating to ${run.to}`,
      line: `${run.step}. Yardhand restarts on the way; this page follows along.`,
    }
  if (run.state === 'done') return { kind: 'done', title: `Updated to ${run.to}`, line: null }
  if (run.state === 'failed')
    return {
      kind: 'failed',
      title: `The update to ${run.to} failed and ${run.from} was put back`,
      line: run.detail,
    }
  return { kind: 'refused', title: 'The update was refused', line: run.detail }
}

/**
 * The headline. A run that ended only leads while it is about the newest version: once a newer one is out, or the
 * failed one was replaced, the card goes back to saying what is available.
 */
export const headlineOf = (view: Pick<Updates, 'current' | 'latest' | 'newer' | 'status'>): Headline => {
  const { status, latest } = view
  if (status?.state === 'working') return outcomeLine(status)
  if (status && status.state !== 'done' && latest && status.to === latest.version && view.newer)
    return outcomeLine(status)
  if (view.newer && latest)
    return {
      kind: 'available',
      title: `Yardhand ${latest.version} is available`,
      line: `This is ${view.current}.`,
    }
  return {
    kind: 'current',
    title: `Yardhand ${view.current}`,
    line: latest ? 'This is the newest version.' : 'No check for a newer version has run yet.',
  }
}

/** Why "Update automatically" can't be switched on here, or null when it can. */
export const autoBlocked = (view: Pick<Updates, 'updater' | 'auto'>) =>
  view.updater.present || view.auto ? null : 'Needs the updater container, which isn’t running beside this instance.'

/** What "Update now" does here, in a line under the button; null where the owner runs the commands. */
export const howLine = (how: Updates['how']) =>
  how === 'updater'
    ? 'The updater checks the release’s signature, backs up the data, starts the new version and puts the old one back if it doesn’t come up.'
    : how === 'hook'
      ? 'Calls the deploy hook set for this instance; the platform then starts the new version.'
      : null

/** A past run in a word, with its tone. */
export const OUTCOME: Record<Run['state'], { label: string; tone: 'ok' | 'error' | 'neutral' }> = {
  working: { label: 'Under way', tone: 'neutral' },
  done: { label: 'Updated', tone: 'ok' },
  failed: { label: 'Failed, put back', tone: 'error' },
  refused: { label: 'Refused', tone: 'neutral' },
}

/** How long the page waits for the updater to take a request before it stops asking. */
export const TAKEN_WITHIN_MS = 2 * 60_000

/**
 * Whether to keep asking: a run is under way, or one was just asked for and the updater hasn't answered yet (it
 * answers with a run that has another id than the one before the click).
 */
export const follows = (status: Run | null, asked: { before: string | null; at: number } | null, now = Date.now()) =>
  status?.state === 'working' ||
  Boolean(asked && (status?.id ?? null) === asked.before && now - asked.at < TAKEN_WITHIN_MS)

/**
 * The new version's app replaces this one once the run this page watched ends well. The run that was there before
 * the click (`before`) is an older one: its good end is no reason to load anything.
 */
export const reloadsAfter = (watched: boolean, status: Run | null, before: string | null = null) =>
  watched && status?.state === 'done' && status.id !== before

/** Home says a newer version is out, unless an update to it is already under way. */
export const noticeOf = (view: Pick<Updates, 'newer' | 'latest' | 'status' | 'current'>) =>
  view.newer && view.latest && view.status?.state !== 'working'
    ? { version: view.latest.version, current: view.current, notes: view.latest.notes }
    : null
