/**
 * Live sync: one listening connection per upstream that announces its changes. A notice syncs that upstream a few
 * seconds later (notices close together make one sync); a dropped stream is listened to again with growing pauses.
 * The hourly sync stays as the backup for upstreams that announce nothing, and for notices missed while away.
 */
import type { Adapters, Credential, Watch } from '../../adapters/index.js'
import type { UpstreamsRepo } from './repo.js'
import { endpointOf } from './sync.js'

export type WatchState = {
  upstream: string
  /** `listening`: a stream is open. `reconnecting`: it dropped, trying again. `quiet`: it announces nothing. */
  state: 'listening' | 'reconnecting' | 'quiet'
  since: string
  lastChangeAt: string | null
  error: string | null
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const createWatcher = ({
  upstreams,
  adapters,
  credentialOf,
  sync,
  debounceMs = 5_000,
  retryMs = [5_000, 15_000, 60_000, 300_000],
}: {
  upstreams: UpstreamsRepo
  adapters: Adapters
  credentialOf: (id: string) => Promise<Credential | undefined>
  sync: (id: string) => Promise<unknown>
  debounceMs?: number
  /** Pauses before listening again after a drop, the last one repeating. */
  retryMs?: number[]
}) => {
  type Entry = WatchState & { watch: Watch | null; timer: NodeJS.Timeout | null; attempts: number; generation: number }
  const entries = new Map<string, Entry>()
  let running = false

  const set = (id: string, change: Partial<Entry>) => {
    const entry = entries.get(id)
    if (entry) entries.set(id, { ...entry, ...change })
  }

  /** Notices close together make one sync. */
  const changed = (id: string, generation: number) => {
    const entry = entries.get(id)
    if (!entry || entry.generation !== generation) return
    if (entry.timer) clearTimeout(entry.timer)
    const timer = setTimeout(() => {
      set(id, { timer: null, lastChangeAt: new Date().toISOString() })
      void sync(id).catch(() => {})
    }, debounceMs)
    timer.unref()
    set(id, { timer })
  }

  const open = async (id: string, generation: number): Promise<void> => {
    const row = await upstreams.get(id)
    const entry = entries.get(id)
    if (!running || !row?.enabled || !entry || entry.generation !== generation) return
    try {
      const watch = await adapters
        .for(row.kind)
        .watch(endpointOf(row), await credentialOf(id), () => changed(id, generation))
      if (entries.get(id)?.generation !== generation) {
        await watch?.close()
        return
      }
      if (!watch) {
        set(id, { state: 'quiet', since: new Date().toISOString(), watch: null, error: null })
        return
      }
      set(id, { state: 'listening', since: new Date().toISOString(), watch, attempts: 0, error: null })
      await watch.closed
      if (entries.get(id)?.generation !== generation) return
      retry(id, generation, 'The stream closed.')
    } catch (error) {
      if (entries.get(id)?.generation === generation) retry(id, generation, message(error))
    }
  }

  const retry = (id: string, generation: number, error: string) => {
    const entry = entries.get(id)
    if (!entry || !running) return
    const pause = retryMs[Math.min(entry.attempts, retryMs.length - 1)] ?? 300_000
    set(id, {
      state: 'reconnecting',
      since: new Date().toISOString(),
      watch: null,
      attempts: entry.attempts + 1,
      error,
    })
    setTimeout(() => void open(id, generation), pause).unref()
  }

  /** Stops listening to one upstream. */
  const stop = async (id: string) => {
    const entry = entries.get(id)
    if (!entry) return
    entries.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    await entry.watch?.close()
  }

  /** Listens to one upstream afresh: after it is added, its address or key changes, or it is switched on. */
  const restart = async (id: string) => {
    const generation = (entries.get(id)?.generation ?? 0) + 1
    await stop(id)
    if (!running) return
    entries.set(id, {
      upstream: id,
      state: 'reconnecting',
      since: new Date().toISOString(),
      lastChangeAt: null,
      error: null,
      watch: null,
      timer: null,
      attempts: 0,
      generation,
    })
    void open(id, generation)
  }

  return {
    /** Listens to every enabled upstream; the running server calls this once. */
    start: async () => {
      running = true
      for (const row of await upstreams.list()) if (row.enabled) await restart(row.id)
    },
    restart,
    stop,
    stopAll: async () => {
      running = false
      for (const id of [...entries.keys()]) await stop(id)
    },
    states: (): WatchState[] =>
      [...entries.values()]
        .map(({ upstream, state, since, lastChangeAt, error }) => ({ upstream, state, since, lastChangeAt, error }))
        .sort((a, b) => a.upstream.localeCompare(b.upstream)),
  }
}

export type Watcher = ReturnType<typeof createWatcher>
