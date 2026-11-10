/**
 * Search by meaning over tool descriptions, with the kit's vectors (Gemini Embedding 2): a ledger on the state volume
 * that only pays for new or changed descriptions, refreshed after every sync. `fuse` merges it with keyword search by
 * reciprocal-rank fusion, so an exact name still wins and a paraphrase still finds the tool.
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
  type VectorSpace,
  vectorSpace,
} from '../../kit/vectors/index.js'
import type { LiveTool, ToolsRepo } from './repo.js'

const RRF_K = 60
/** One refresh never spends more than this (USD); a rerun continues where it stopped. */
const REFRESH_BUDGET = 0.25

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

export type MeaningSearch = {
  refresh: () => Promise<void>
  names: (q: string, limit: number) => Promise<string[]>
  /** Whether it can search now (it has a key); absent means yes. */
  ready?: () => boolean
}

export const createMeaningSearch = ({
  file,
  tools,
  contexts = async () => new Map(),
  embed,
  query,
  log = (message) => console.log(message),
}: {
  file: string
  tools: ToolsRepo
  /** Per upstream id, the context its tools are embedded with. */
  contexts?: () => Promise<Map<string, string>>
  embed: (inputs: EmbeddingInput[]) => Promise<Embedded>
  query: (q: string) => Promise<Float32Array>
  log?: (message: string) => void
}): MeaningSearch => {
  let space: VectorSpace | null = null
  let running: Promise<void> = Promise.resolve()
  const rebuild = async () => {
    mkdirSync(dirname(file), { recursive: true })
    const live = await tools.listLive({ upstreams: 'all', limit: 100_000 })
    const context = await contexts()
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
    const names = new Set(live.map((tool) => tool.name))
    space = vectorSpace(await readLedger(file), (key) => names.has(key))
  }
  return {
    // One refresh at a time; a failed one leaves the last good space serving
    refresh: () => {
      running = running
        .then(rebuild)
        .catch((error: unknown) =>
          log(`meaning: refresh failed (${error instanceof Error ? error.message : String(error)})`),
        )
      return running
    },
    names: async (q, limit) =>
      space?.keys.length ? nearest(space, await query(q), { limit }).map((match) => match.key) : [],
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
