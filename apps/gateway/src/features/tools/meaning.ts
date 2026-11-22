/**
 * Search by meaning over tool descriptions, with the kit's vectors (Gemini Embedding 2): a ledger on the state volume
 * that only pays for new or changed descriptions, refreshed at start and after every sync and approval, and again
 * by itself, later each time, after a refresh that failed or stopped (`RETRY_DELAYS`). `fuse` merges it with
 * keyword search by reciprocal-rank fusion, so a name leads and a paraphrase still finds the tool. On a catalog of
 * `MIN_ROWS` tools or more a keyword hit, an exact name included, counts only from `barsFor`'s floor up; one with no
 * vector yet can't be scored and counts, and so does every hit for the owner typing in the app. `standouts` is the
 * search that can answer nothing; `names` always answers.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  createEmbedder,
  documentText,
  type Embedded,
  type EmbeddingInput,
  embedMissing,
  embedRequest,
  nearest,
  readLedger,
  standouts,
  type VectorSpace,
  vectorSpace,
} from '../../kit/vectors/index.js'
import type { LiveTool, ToolsRepo } from './repo.js'

const RRF_K = 60
/** One refresh never spends more than this (USD); a rerun continues where it stopped. */
const REFRESH_BUDGET = 0.25
/**
 * With fewer tools than this there is no bar: too few to tell a match from noise, so search answers with the nearest,
 * as it always did. Counted in tools that have a vector. Set by replaying logged searches (what the rule cost,
 * measured, is in docs/releases/0.5.0.md).
 */
export const MIN_ROWS = 50
/**
 * How far above the question's mean over every tool a tool must stand, for a catalog of `rows` tools that have a
 * vector: `stands` to be found by meaning alone (absent: the kit's own bar, 3.5 and rising), `found` when the words
 * found it too. Both rise with the catalog: in a small one a right answer stands less far out, and in a large one
 * more tools pass a low bar by chance. Set by replaying logged searches on catalogs of each size (what the rule cost,
 * measured, is in docs/releases/0.5.0.md).
 */
export const barsFor = (rows: number): { stands?: number; found: number } =>
  rows < 150 ? { stands: 3, found: 1 } : rows < 1000 ? { found: 1.5 } : { found: 2 }

/** Reciprocal-rank fusion: names in any list, best combined rank first; `weights` scale each list (default 1). */
export const fuse = (lists: string[][], limit: number, weights: number[] = []) => {
  const scores = new Map<string, number>()
  for (const [index, list] of lists.entries())
    for (const [rank, name] of list.entries())
      scores.set(name, (scores.get(name) ?? 0) + (weights[index] ?? 1) / (RRF_K + rank + 1))
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name)
}

/** What a tool is about: its own text, plus what its upstream is (a tool rarely says it belongs to an LLM tracer). */
export const documentOf = (
  tool: Pick<LiveTool, 'name' | 'upstreamId' | 'title' | 'description'>,
  upstreamContext = '',
) => documentText(tool.title ?? tool.name, [`${tool.name} from ${tool.upstreamId}`, upstreamContext, tool.description])

/** The upstream's title and the start of its instructions, as context for its tools. */
export const contextOf = (upstream: { title: string; instructions: string | null }) =>
  [upstream.title, upstream.instructions?.replace(/\s+/g, ' ').slice(0, 300)].filter(Boolean).join(': ')

/** How long a failed or stopped refresh waits before it is tried again, then each time after; the last repeats. */
export const RETRY_DELAYS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000]

/**
 * Where the vectors stand: how many live tools there are, how many have no vector (found by their words only), what
 * stopped the last refresh, and when it is tried again.
 */
export type VectorStatus = { tools: number; missing: number; failed: string | null; retryAt: string | null }

export type MeaningSearch = {
  /** Embeds what has no vector or changed; one that fails or stops is tried again by itself, later each time. */
  refresh: () => Promise<void>
  /** The nearest tools, best first: an answer every time, for a suggestion someone confirms. */
  names: (q: string, limit: number) => Promise<string[]>
  /**
   * The tools that stand out for `q`, best first. Every tool is scored, so the spread is the whole catalog's, and
   * `keep` then holds it to the caller's. The bar is `barsFor` the catalog's size: the one to stand out by meaning
   * alone or, with `found`, the lower one for tools the words already found. Null when there is no bar to hold
   * a tool to (fewer than `MIN_ROWS` tools, nothing embedded yet, no key): the caller then searches as before.
   */
  standouts: (
    q: string,
    pick: { limit: number; keep: (name: string) => boolean; found?: boolean },
  ) => Promise<string[] | null>
  /** Whether this tool has a vector: one synced or approved since the last refresh has none, and can't be scored. */
  has: (name: string) => boolean
  /** Whether it can search now (it has a key); absent means yes. */
  ready?: () => boolean
  /** Where the vectors stand; absent where nothing counts them. */
  status?: () => VectorStatus
  /** No more tries: the search is being replaced (a new key). */
  stop?: () => void
}

export const createMeaningSearch = ({
  file,
  tools,
  contexts = async () => new Map(),
  embed,
  query,
  log = (message) => console.log(message),
  retryDelays = RETRY_DELAYS,
}: {
  file: string
  tools: ToolsRepo
  /** Per upstream id, the context its tools are embedded with. */
  contexts?: () => Promise<Map<string, string>>
  embed: (inputs: EmbeddingInput[]) => Promise<Embedded>
  query: (q: string) => Promise<Float32Array>
  log?: (message: string) => void
  retryDelays?: number[]
}): MeaningSearch => {
  let space: VectorSpace | null = null
  let running: Promise<void> = Promise.resolve()
  let counted = { tools: 0, missing: 0 }
  let failed: string | null = null
  let retry: { timer: ReturnType<typeof setTimeout>; at: number } | null = null
  let failures = 0
  let stopped = false
  /** Embeds what is missing; throws when it failed or stopped, after serving every vector the ledger holds. */
  const rebuild = async () => {
    mkdirSync(dirname(file), { recursive: true })
    const live = await tools.listLive({ upstreams: 'all', limit: 100_000 })
    const context = await contexts()
    const names = new Set(live.map((tool) => tool.name))
    try {
      const run = await embedMissing({
        file,
        items: live.map((tool) => ({ key: tool.name, content: documentOf(tool, context.get(tool.upstreamId)) })),
        embed,
        budget: REFRESH_BUDGET,
      })
      if (run.embedded || run.stopped)
        log(
          `meaning: embedded ${run.embedded}, fresh ${run.fresh}, $${run.cost.toFixed(4)}${run.stopped ? `, stopped (${run.stopped})` : ''}`,
        )
      if (run.stopped)
        throw new Error(
          run.stopped === 'spend cap'
            ? 'the key’s spend cap was reached'
            : `one refresh spends $${REFRESH_BUDGET} at most, and that was spent`,
        )
    } finally {
      space = vectorSpace(await readLedger(file), (key) => names.has(key))
      counted = { tools: names.size, missing: names.size - space.keys.length }
    }
  }
  const cancelRetry = () => {
    if (retry) clearTimeout(retry.timer)
    retry = null
  }
  const retryLater = () => {
    cancelRetry()
    if (stopped) return
    const delay = retryDelays[Math.min(failures, retryDelays.length - 1)] ?? 60_000
    failures += 1
    const timer = setTimeout(() => {
      retry = null
      if (!stopped) void refresh()
    }, delay)
    timer.unref?.()
    retry = { timer, at: Date.now() + delay }
  }
  // One refresh at a time, nothing once stopped; a failed one keeps serving what the ledger holds and one try waits
  const refresh = () => {
    running = running
      .then(async () => {
        if (stopped) return
        cancelRetry()
        await rebuild()
      })
      .then(
        () => {
          failed = null
          failures = 0
        },
        (error: unknown) => {
          failed = (error instanceof Error ? error.message : String(error)).slice(0, 300)
          log(`meaning: refresh failed (${failed})`)
          retryLater()
        },
      )
    return running
  }
  return {
    refresh,
    status: () => ({ ...counted, failed, retryAt: retry ? new Date(retry.at).toISOString() : null }),
    stop: () => {
      stopped = true
      cancelRetry()
    },
    names: async (q, limit) =>
      space?.keys.length ? nearest(space, await query(q), { limit }).map((match) => match.key) : [],
    standouts: async (q, { limit, keep, found }) => {
      if (!space || space.keys.length < MIN_ROWS) return null
      const bars = barsFor(space.keys.length)
      const minZ = found ? bars.found : bars.stands
      return standouts(space, await query(q), { limit, keep, minZ }).map((match) => match.key)
    },
    has: (name) => space?.rowOf.has(name) ?? false,
  }
}

/** The real thing, on OpenRouter with the gateway's own capped key. */
export const openRouterMeaning = ({
  apiKey,
  file,
  tools,
  contexts,
}: {
  apiKey: string
  file: string
  tools: ToolsRepo
  contexts: () => Promise<Map<string, string>>
}) => {
  const embedder = createEmbedder({ apiKey })
  return createMeaningSearch({
    file,
    tools,
    contexts,
    embed: (inputs) => embedRequest(apiKey, inputs),
    query: embedder.query,
  })
}
