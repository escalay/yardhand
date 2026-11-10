/**
 * The gateway's own schedule: resync every enabled upstream each hour (so third-party changes reach review on their
 * own), and once a day drop calls older than 90 days and snapshot the database into `<state>/backups`, keeping 7.
 * Each run is remembered across restarts (what it did, how long it took), so a job is due by when it last ran, not by
 * when the server started: a deploy syncs once, and never makes another backup the same day. A failing job logs and
 * tries again within the hour; it never stops the server.
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { Services } from './services.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const KEEP_DAYS = 90
const KEEP_BACKUPS = 7
const MINUTE = 60 * 1000

const log = (job: string, error: unknown) =>
  console.warn(`job ${job}: ${error instanceof Error ? error.message : String(error)}`)

/** Syncs every enabled upstream; says how many, and throws naming the ones that failed. */
export const syncAll = async ({ upstreams, sync }: Pick<Services, 'upstreams' | 'sync'>) => {
  const enabled = (await upstreams.list()).filter((upstream) => upstream.enabled)
  const failed: string[] = []
  for (const upstream of enabled)
    await sync(upstream.id).catch((error) => {
      failed.push(upstream.id)
      log(`sync ${upstream.id}`, error)
    })
  const plural = (count: number) => `${count} connection${count === 1 ? '' : 's'}`
  if (failed.length)
    throw new Error(
      `${enabled.length - failed.length} of ${plural(enabled.length)} synced; failed: ${failed.join(', ')}`,
    )
  return `${plural(enabled.length)} synced`
}

/**
 * Tells the owner when changes (tools, manuals, playbooks, links) start waiting for review (only versions it hasn't announced yet), so a changed
 * third-party description never waits unseen. `post` sends one message; without a webhook nothing is sent. `kept`
 * remembers what was announced across restarts, so a deploy doesn't announce everything again.
 */
export const reviewNotifier = (
  post: ((text: string) => Promise<void>) | null,
  kept?: { load: () => Promise<string[] | undefined>; save: (ids: string[]) => Promise<unknown> },
) => {
  let announced: Set<string> | null = null
  return async ({ tools, catalog }: Pick<Services, 'tools' | 'catalog'>, origin: string) => {
    if (!post) return
    announced ??= new Set((await kept?.load().catch(() => undefined)) ?? [])
    const told = announced
    const pending = [
      ...(await tools.pending()).map(({ tool, version }) => ({
        id: version.id,
        line: `• ${tool.name} (${tool.liveVersion ? 'changed' : 'new'} tool, version ${version.id})`,
      })),
      ...(await catalog.pending()).map(({ item, version }) => ({
        id: version.id,
        line: `• ${item.name} (${item.liveVersion ? 'changed' : 'new'} ${item.kind}, version ${version.id})`,
      })),
    ]
    const fresh = pending.filter(({ id }) => !told.has(id))
    if (!fresh.length) return
    const lines = fresh.slice(0, 10).map(({ line }) => line)
    await post(
      [
        `**Yardhand:** ${fresh.length} change${fresh.length === 1 ? '' : 's'} waiting for review`,
        ...lines,
        ...(fresh.length > 10 ? [`…and ${fresh.length - 10} more`] : []),
        `Review them: ${origin}/app/tools/reviews (or GET ${origin}/api/reviews)`,
      ].join('\n'),
    )
    for (const { id } of fresh) told.add(id)
    // Only what still waits is worth remembering
    await kept?.save(pending.map(({ id }) => id).filter((id) => told.has(id)))
  }
}

/** A Discord webhook as a `post` for `reviewNotifier`. */
export const discordPost = (webhookUrl: string | undefined) =>
  webhookUrl
    ? async (content: string) => {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content }),
        })
        if (!response.ok) throw new Error(`Discord webhook answered ${response.status}`)
      }
    : null

/** A consistent copy of the live database (`VACUUM INTO`), named by day; older copies beyond 7 are removed. */
export const backup = async ({ db }: Pick<Services, 'db'>, stateDir: string, now = new Date()) => {
  const dir = join(stateDir, 'backups')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `state-${now.toISOString().slice(0, 10)}.sqlite`)
  rmSync(file, { force: true })
  await db.run(sql.raw(`vacuum into '${file.replaceAll("'", "''")}'`))
  for (const old of readdirSync(dir)
    .filter((name) => /^state-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
    .sort()
    .slice(0, -KEEP_BACKUPS))
    rmSync(join(dir, old))
  return file
}

/** Drops what is past keeping, then backs up; says what it wrote, and throws when a part failed. */
export const daily = async (services: Pick<Services, 'db' | 'calls' | 'searches'>, stateDir: string) => {
  const before = new Date(Date.now() - KEEP_DAYS * DAY).toISOString()
  const failed: string[] = []
  const part = (name: string) => (error: unknown) => {
    failed.push(name)
    log(name, error)
    return null
  }
  await services.calls.prune(before).catch(part('dropping old calls'))
  await services.searches.prune(before).catch(part('dropping old searches'))
  const file = await backup(services, stateDir).catch(part('the backup'))
  if (failed.length) throw new Error(`Failed: ${failed.join(', ')}. The server log has why.`)
  const megabytes = file ? (statSync(file).size / 1_000_000).toFixed(1) : '0'
  return `${megabytes} MB backed up; calls older than ${KEEP_DAYS} days dropped`
}

export type JobRun = { at: string; ok: boolean; detail: string | null; ms: number | null }

export const JOBS = { sync: HOUR, backup: DAY } as const
export type JobName = keyof typeof JOBS

/** When a job is next due: a period after a good run, within the hour after a failed one, now if it never ran. */
export const dueAt = (name: JobName, last: Pick<JobRun, 'at' | 'ok'> | undefined) =>
  last ? new Date(last.at).getTime() + (last.ok ? JOBS[name] : Math.min(JOBS[name], HOUR)) : 0

/**
 * The scheduler: each job runs when due, one run at a time, and its last run is kept (in `runs`, and through `kept`
 * across restarts). `run` is what "Run now" calls; it joins a run already going.
 */
export const createJobs = (
  work: Record<JobName, () => Promise<string>>,
  runs: Map<string, JobRun>,
  kept?: {
    load: () => Promise<Record<string, JobRun> | undefined>
    save: (all: Record<string, JobRun>) => Promise<unknown>
  },
) => {
  const running = new Map<JobName, Promise<void>>()
  const run = (name: JobName) => {
    const going = running.get(name)
    if (going) return going
    const started = Date.now()
    const note = (ok: boolean, detail: string | null) =>
      runs.set(name, { at: new Date(started).toISOString(), ok, detail, ms: Date.now() - started })
    const turn = work[name]()
      .then(
        (detail) => note(true, detail),
        (error: unknown) => {
          note(false, error instanceof Error ? error.message : String(error))
          log(name, error)
        },
      )
      .then(() => kept?.save(Object.fromEntries(runs)).catch((error) => log('remembering runs', error)))
      .then(() => {
        running.delete(name)
      })
    running.set(name, turn)
    return turn
  }
  const names = Object.keys(JOBS) as JobName[]
  return {
    run,
    /** Loads what earlier processes ran, so nothing runs again before it is due. */
    load: async () => {
      for (const [name, last] of Object.entries((await kept?.load().catch(() => undefined)) ?? {}))
        if (!runs.has(name)) runs.set(name, last)
    },
    /** Runs whatever is due now. */
    tick: (now = Date.now()) =>
      Promise.all(names.filter((name) => !running.has(name) && dueAt(name, runs.get(name)) <= now).map(run)),
    view: () =>
      names.map((name) => {
        const last = runs.get(name)
        return {
          name,
          at: last?.at ?? null,
          ok: last?.ok ?? null,
          detail: last?.detail ?? null,
          ms: last?.ms ?? null,
          next: new Date(Math.max(dueAt(name, last), Date.now())).toISOString(),
          running: running.has(name),
        }
      }),
  }
}

export type Jobs = ReturnType<typeof createJobs>

export const startJobs = (services: Services, { stateDir, webhookUrl }: { stateDir: string; webhookUrl?: string }) => {
  const notify = reviewNotifier(discordPost(webhookUrl), {
    load: () => services.vault.get<string[]>('notices:reviews'),
    save: (ids) => services.vault.put('notices:reviews', ids),
  })
  const jobs = createJobs(
    {
      sync: async () => {
        const said = await syncAll(services)
        await notify(services, services.publicOrigin).catch((error) => log('review notice', error))
        return said
      },
      backup: () => daily(services, stateDir),
    },
    services.jobRuns,
    {
      load: () => services.vault.get<Record<string, JobRun>>('jobs:runs'),
      save: (all) => services.vault.put('jobs:runs', all),
    },
  )
  services.jobs.current = jobs
  // A sync soon after boot whatever the clock says, so a deploy picks up what servers offer now; the rest when due
  // Earlier runs are read at once, so Settings never shows a job as never run while the server warms up
  const loaded = jobs.load()
  const first = setTimeout(() => void loaded.then(() => jobs.run('sync')), 15_000)
  const timer = setInterval(() => void loaded.then(() => jobs.tick()), MINUTE)
  first.unref()
  timer.unref()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
