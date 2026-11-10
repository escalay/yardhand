/**
 * When an upstream asks something mid-call (MCP 2026-07-28 input requests): the state the gateway hands the caller
 * with the questions, sealed so a caller can't steer another client's call or another tool with it, and the answers
 * the gateway gives for a caller that can't answer (a script, an older MCP client).
 */
import { createHash } from 'node:crypto'
import { ProblemError } from '../../kit/index.js'
import { seal, unseal } from '../vault/crypto.js'

const ANSWER_WITHIN_MS = 10 * 60 * 1000
const PREFIX = 'gw1.'

type Bound = { clientId: string; tool: string; args: Record<string, unknown> }
type Sealed = { upstreamState: string | null; clientId: string; tool: string; argsHash: string; expiresAt: number }

const hashOf = (args: Record<string, unknown>) => createHash('sha256').update(JSON.stringify(args)).digest('base64url')

/** The gateway's `requestState`: the upstream's own state, bound to this client, tool and arguments for 10 minutes. */
export const sealAsk = (key: Buffer, upstreamState: string | undefined, bound: Bound, now = Date.now()) =>
  PREFIX +
  seal(
    key,
    JSON.stringify({
      upstreamState: upstreamState ?? null,
      clientId: bound.clientId,
      tool: bound.tool,
      argsHash: hashOf(bound.args),
      expiresAt: now + ANSWER_WITHIN_MS,
    } satisfies Sealed),
  )

/** The upstream's state back, if the sealed state belongs to this very call and is still fresh. */
export const openAsk = (key: Buffer, state: string, bound: Bound, now = Date.now()) => {
  const refuse = (why: string) =>
    new ProblemError('bad_request', {
      detail: `These answers can't go on: ${why}. Call the tool again from the start.`,
    })
  if (!state.startsWith(PREFIX)) throw refuse('the requestState is not one the gateway gave')
  let sealed: Sealed
  try {
    sealed = JSON.parse(unseal(key, state.slice(PREFIX.length))) as Sealed
  } catch {
    throw refuse('the requestState is not one the gateway gave')
  }
  if (sealed.expiresAt < now) throw refuse('they came more than ten minutes after the question')
  if (sealed.clientId !== bound.clientId || sealed.tool !== bound.tool || sealed.argsHash !== hashOf(bound.args))
    throw refuse('they belong to another call (same client, tool and arguments are needed)')
  return sealed.upstreamState ?? undefined
}

type InputRequest = {
  method?: string
  params?: { message?: string; mode?: string; url?: string; requestedSchema?: { properties?: Record<string, unknown> } }
}

/** One line per question, for the log and for a result: `asked "Delete 3 boards?" (confirm)`. */
export const questionsOf = (inputRequests: Record<string, unknown>) =>
  Object.values(inputRequests).map((raw) => {
    const request = raw as InputRequest
    if (request.method === 'elicitation/create') {
      const fields = Object.keys(request.params?.requestedSchema?.properties ?? {})
      return request.params?.mode === 'url'
        ? `asked to open ${request.params.url ?? 'a link'}: "${request.params?.message ?? ''}"`
        : `asked "${request.params?.message ?? ''}"${fields.length ? ` (${fields.join(', ')})` : ''}`
    }
    if (request.method === 'sampling/createMessage') return 'asked to use your model (sampling)'
    if (request.method === 'roots/list') return 'asked for your workspace folders (roots)'
    return `asked something the gateway doesn't know (${request.method ?? 'unknown'})`
  })

/**
 * Answers for a caller that can't: a question or a link to open is declined (a declined confirmation means "don't");
 * folders are none. A request to use the caller's model can't be answered for it, so the call stops with why.
 */
export const answersFor = (inputRequests: Record<string, unknown>) => {
  const responses: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(inputRequests)) {
    const request = raw as InputRequest
    if (request.method === 'elicitation/create') responses[key] = { action: 'decline' }
    else if (request.method === 'roots/list') responses[key] = { roots: [] }
    else
      return {
        responses: null,
        refusal: `The server ${questionsOf({ [key]: raw })[0]}, which only a client that answers questions mid-call can do. Call it from an MCP client that supports input requests.`,
      }
  }
  return { responses, refusal: null }
}
