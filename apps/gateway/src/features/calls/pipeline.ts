/**
 * The one way a tool runs: resolve → allowlist → scope → credential → adapter → record. MCP, REST and pinned tools
 * all come through here, so every call meets the same rules and lands in the same log.
 */
import type { Adapters, Asked, Credential, Progress, Resume, ToolResult } from '../../adapters/index.js'
import { ProblemError } from '../../kit/index.js'
import { allows, entryOf, type Principal } from '../clients/principals.js'
import { effectOf } from '../tools/groups.js'
import { isOff, needsWrite, type ToolsRepo } from '../tools/repo.js'
import type { UpstreamsRepo } from '../upstreams/repo.js'
import { endpointOf } from '../upstreams/sync.js'
import { checkArguments } from './arguments.js'
import { answersFor, openAsk, questionsOf, sealAsk } from './asking.js'
import type { Handed } from './handed.js'
import { rewriteLinks } from './links.js'
import type { CallsRepo } from './repo.js'
import type { CallRow } from './schema.js'

export type CallOutcome = {
  id: string
  tool: string
  status: CallRow['status']
  durationMs: number
  result: ToolResult
  /** Set when the upstream asked something: answer with these questions' keys and this state to go on. */
  asked?: Asked & { requestState: string }
}

/** How many times a caller that can't answer is answered for before the gateway gives up on a call. */
const MAX_ROUNDS = 3

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const createPipeline =
  ({
    tools,
    upstreams,
    adapters,
    calls,
    credentialOf,
    key,
    handed,
  }: {
    tools: ToolsRepo
    upstreams: UpstreamsRepo
    adapters: Adapters
    calls: CallsRepo
    credentialOf: (id: string) => Promise<Credential | undefined>
    /** The master key: it seals the state handed out with an upstream's questions. */
    key: Buffer
    /** Notes the links a pack key is handed, which are all it may open besides its tools. */
    handed: Handed
  }) =>
  async ({
    principal,
    toolName,
    args,
    via,
    origin,
    interactive = false,
    answers,
    onProgress,
  }: {
    principal: Principal
    toolName: string
    args: Record<string, unknown>
    via: CallRow['via']
    /** The gateway's public origin: links to the upstream's host are rewritten to its proxy here. */
    origin?: string
    /** The caller answers questions mid-call itself; otherwise the gateway answers for it (see `answersFor`). */
    interactive?: boolean
    /** Answers to the questions a previous round of this same call asked, with the state handed out then. */
    answers?: { inputResponses: Record<string, unknown>; requestState: string }
    /** Progress the upstream reports while it works. */
    onProgress?: (progress: Progress) => void
  }): Promise<CallOutcome> => {
    const started = Date.now()
    // Logged under the tool's own name once known, whatever name its pack calls it
    let base = { clientId: principal.id, clientName: principal.name, tool: toolName, via }
    const refuse = async (problem: ProblemError, upstreamId: string | null = null) => {
      await calls.record({
        ...base,
        upstreamId,
        versionId: null,
        status: 'refused',
        error: problem.message,
        durationMs: Date.now() - started,
        resultBytes: 0,
      })
      throw problem
    }

    // A pack calls its tools by its own names and fills the inputs it fixes
    const entry = entryOf(principal, toolName)
    const tool = await tools.live(entry?.tool ?? toolName)
    if (!tool || !allows(principal, tool.upstreamId))
      return refuse(
        new ProblemError('not_found', {
          detail: `No tool ${toolName} for this client: search_tools (MCP) or GET /api/tools?q=… finds the ones you may use.`,
        }),
      )
    if (!entry)
      return refuse(
        new ProblemError('forbidden', {
          detail: `${toolName} is not in ${principal.pack?.title ?? 'the pack'}, the pack this key is locked to. search_tools lists what it holds.`,
        }),
        tool.upstreamId,
      )
    base = { ...base, tool: tool.name }
    const overridden = Object.keys(entry.fixed).filter((key) => key in args)
    if (overridden.length)
      return refuse(
        new ProblemError('bad_request', {
          detail: `${toolName}: ${principal.pack?.title ?? 'the pack'} fills ${overridden.join(', ')} itself, so leave ${overridden.length === 1 ? 'it' : 'them'} out.`,
          errors: overridden.map((key) => ({
            in: 'body' as const,
            path: `arguments.${key}`,
            message: 'is fixed by the pack',
          })),
        }),
        tool.upstreamId,
      )
    const upstream = await upstreams.get(tool.upstreamId)
    if (!upstream?.enabled)
      return refuse(
        new ProblemError('unavailable', { detail: `Upstream ${tool.upstreamId} is switched off.` }),
        tool.upstreamId,
      )
    if (isOff(tool))
      return refuse(
        new ProblemError('forbidden', {
          detail:
            tool.offBy === 'group'
              ? `${toolName} is in ${tool.group?.title ?? 'a group'}, which the owner switched off.`
              : tool.offBy === 'effect'
                ? `${toolName} ${effectOf(tool) === 'deletes' ? 'deletes' : 'changes'} things, and the owner switched those off for ${tool.upstreamId}.`
                : `${toolName} is switched off by the owner.`,
        }),
        tool.upstreamId,
      )
    const write = needsWrite(tool)
    if (write && principal.scope !== 'write')
      return refuse(
        new ProblemError('forbidden', {
          detail: `${toolName} changes things, and this client is read-only. The owner can grant write scope.`,
        }),
        tool.upstreamId,
      )
    let sent: Record<string, unknown>
    try {
      sent = checkArguments(tool, { ...args, ...entry.fixed })
    } catch (problem) {
      return refuse(problem as ProblemError, tool.upstreamId)
    }

    try {
      const bound = { clientId: principal.id, tool: toolName, args }
      let resume: Resume | undefined = answers
        ? {
            inputResponses: answers.inputResponses,
            ...(() => {
              const upstreamState = openAsk(key, answers.requestState, bound)
              return upstreamState ? { requestState: upstreamState } : {}
            })(),
          }
        : undefined
      const notes: string[] = []
      let raw: ToolResult
      for (let round = 1; ; round++) {
        raw = await adapters
          .for(upstream.kind)
          .call(endpointOf(upstream), await credentialOf(upstream.id), tool.remoteName, sent, {
            retry: !write,
            ...(resume ? { resume } : {}),
            ...(onProgress ? { onProgress } : {}),
          })
        if (!raw.asked) break
        const questions = questionsOf(raw.asked.inputRequests)
        if (interactive) {
          const id = await calls.record({
            ...base,
            upstreamId: upstream.id,
            versionId: tool.versionId,
            status: 'asked',
            error: null,
            durationMs: Date.now() - started,
            resultBytes: 0,
          })
          await calls.keepPayload(id, { arguments: args, asked: raw.asked.inputRequests })
          return {
            id,
            tool: toolName,
            status: 'asked',
            durationMs: Date.now() - started,
            result: { content: [{ type: 'text', text: `The server ${questions.join('; ')}. Answer to go on.` }] },
            asked: {
              inputRequests: raw.asked.inputRequests,
              requestState: sealAsk(key, raw.asked.requestState, bound),
            },
          }
        }
        const { responses, refusal } = answersFor(raw.asked.inputRequests)
        if (!responses || round >= MAX_ROUNDS)
          throw new ProblemError('bad_request', {
            detail:
              refusal ??
              `${toolName} kept asking questions (${questions.join('; ')}); it was stopped after ${MAX_ROUNDS} rounds.`,
          })
        notes.push(...questions)
        resume = {
          inputResponses: responses,
          ...(raw.asked.requestState ? { requestState: raw.asked.requestState } : {}),
        }
      }
      // Said in the result, so the agent knows what was decided for it
      const answered = notes.length
        ? {
            ...raw,
            content: [
              ...raw.content,
              {
                type: 'text',
                text: `[Yardhand: the server ${notes.join('; ')}. This caller can't answer mid-call, so the gateway declined.]`,
              },
            ],
          }
        : raw
      // Links point at the gateway's proxy only while it opens them for this upstream
      const result =
        origin && upstream.linkProxy
          ? rewriteLinks(answered, { upstreamUrl: upstream.url, upstreamId: upstream.id, gatewayOrigin: origin })
          : answered
      const durationMs = Date.now() - started
      const status = result.isError ? 'tool_error' : 'ok'
      const id = await calls.record({
        ...base,
        upstreamId: upstream.id,
        versionId: tool.versionId,
        status,
        error: null,
        durationMs,
        resultBytes: JSON.stringify(result).length,
      })
      // The tool has run: a payload or a link note that fails to save must not turn its answer into an error
      await calls
        .keepPayload(id, { arguments: args, ...(answers ? { answers: answers.inputResponses } : {}), result })
        .catch((error: unknown) => console.warn(`call ${id}: payload not kept (${message(error)})`))
      await handed
        .note(principal, upstream.id, result, origin)
        .catch((error: unknown) => console.warn(`call ${id}: links not noted (${message(error)})`))
      return { id, tool: toolName, status, durationMs, result }
    } catch (error) {
      const id = await calls.record({
        ...base,
        upstreamId: upstream.id,
        versionId: tool.versionId,
        status: 'failed',
        error: message(error).slice(0, 1000),
        durationMs: Date.now() - started,
        resultBytes: 0,
      })
      await calls.keepPayload(id, { arguments: args, error: message(error).slice(0, 4000) })
      throw error instanceof ProblemError
        ? error
        : new ProblemError('upstream', { detail: `${upstream.id}: ${message(error)}` })
    }
  }

export type Pipeline = ReturnType<typeof createPipeline>
