/**
 * Looks at a URL before it becomes an upstream: is it an MCP server or a REST API with an OpenAPI spec, what sign-in
 * does it want, and which tools would it bring. Nothing is saved; the pooled connection is dropped after.
 */
import { randomUUID } from 'node:crypto'
import {
  type Adapters,
  type AuthKind,
  authHeaders,
  type Credential,
  type Listing,
  type RemoteTool,
} from '../../adapters/index.js'
import { summaryOf } from '../tools/handlers.js'
import { hintsWrite } from '../tools/repo.js'

const TIMEOUT_MS = 10_000
const PREVIEW = 100

export type ProbeAuth = { type: AuthKind; header?: string; value?: string }

export type Probe = {
  url: string
  reachable: boolean
  kind: 'mcp' | 'http' | null
  auth: { needed: 'none' | 'key' | 'oauth'; accepted: boolean }
  server: string | null
  instructions: string | null
  http: { spec: string } | null
  suggested: { id: string; title: string }
  toolCount: number | null
  tools: { name: string; title: string | null; summary: string; readOnly: boolean }[]
  offers: { manuals: number; playbooks: number; links: number }
  problem: string | null
}

/** What a listing brings besides tools, counted. */
const offersOf = ({ catalog }: Listing) => ({
  manuals: catalog.manuals?.length ?? 0,
  playbooks: catalog.playbooks?.length ?? 0,
  links: (catalog.templates?.length ?? 0) + (catalog.resources?.length ?? 0),
})

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A short id from the host: `mcp.notion.com` → `notion`, `docs.example.test` → `docs`; unique against `taken`. */
export const suggestId = (url: string, taken: Set<string>) => {
  const labels = new URL(url).hostname.split('.').filter((label) => !['mcp', 'api', 'www', 'server'].includes(label))
  const base =
    (labels[0] ?? 'upstream')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36) || 'upstream'
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

const titleOf = (id: string) => id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ')

/** One MCP `initialize`: does an MCP server answer here, and if it refuses, does it offer OAuth? */
const handshake = async (url: string, headers: Record<string, string>) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'yardhand-probe', version: '1' },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const type = response.headers.get('content-type') ?? ''
  if (response.status === 401) {
    const challenge = response.headers.get('www-authenticate') ?? ''
    await response.body?.cancel()
    const metadata = await fetch(new URL('/.well-known/oauth-protected-resource', url), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then((answer) => answer.ok)
      .catch(() => false)
    return { answer: 'refused' as const, oauth: /resource_metadata/i.test(challenge) || metadata }
  }
  if (response.ok && type.includes('event-stream')) {
    await response.body?.cancel()
    return { answer: 'mcp' as const, oauth: false }
  }
  const body = await response.text()
  if (response.ok && body.includes('"jsonrpc"')) return { answer: 'mcp' as const, oauth: false }
  // A legacy SSE server takes GET with an event stream
  if (response.status === 404 || response.status === 405) {
    const legacy = await fetch(url, {
      headers: { accept: 'text/event-stream', ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null)
    const isStream = Boolean(legacy?.ok && legacy.headers.get('content-type')?.includes('event-stream'))
    await legacy?.body?.cancel().catch(() => {})
    if (isStream) return { answer: 'mcp' as const, oauth: false }
  }
  return { answer: 'other' as const, oauth: false }
}

/** An OpenAPI document at the URL itself or at `/openapi.json` beside it. */
const findSpec = async (url: string, headers: Record<string, string>) => {
  for (const candidate of [url, new URL('/openapi.json', url).toString()]) {
    const response = await fetch(candidate, {
      headers: { accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null)
    if (!response?.ok) continue
    const doc = (await response.json().catch(() => null)) as { openapi?: unknown } | null
    if (typeof doc?.openapi === 'string') return candidate
  }
  return null
}

const previewOf = (tools: RemoteTool[]) =>
  tools.slice(0, PREVIEW).map((tool) => ({
    name: tool.name,
    title: tool.title ?? null,
    summary: summaryOf(tool.description ?? ''),
    readOnly: !hintsWrite(tool.annotations ?? {}),
  }))

export const probeUpstream = async ({
  adapters,
  url,
  auth,
  taken,
}: {
  adapters: Adapters
  url: string
  auth?: ProbeAuth
  taken: Set<string>
}): Promise<Probe> => {
  const id = suggestId(url, taken)
  const base: Probe = {
    url,
    reachable: false,
    kind: null,
    auth: { needed: 'none', accepted: false },
    server: null,
    instructions: null,
    http: null,
    suggested: { id, title: titleOf(id) },
    toolCount: null,
    tools: [],
    offers: { manuals: 0, playbooks: 0, links: 0 },
    problem: null,
  }
  const type: AuthKind = auth?.type === 'oauth' || !auth ? 'none' : auth.type
  const credential: Credential | undefined = auth?.value ? { value: auth.value } : undefined
  let headers: Record<string, string>
  try {
    headers = authHeaders({ auth: type, authHeader: auth?.header ?? null }, credential)
  } catch (error) {
    return { ...base, problem: message(error) }
  }
  const given = type !== 'none'
  const probeId = `probe-${randomUUID().slice(0, 8)}`
  const endpoint = (kind: 'mcp' | 'http', config: Record<string, unknown> | null) => ({
    id: probeId,
    kind,
    url,
    auth: type,
    authHeader: auth?.header ?? null,
    config,
  })

  const first = await handshake(url, headers).catch((error: unknown) => ({ answer: 'down' as const, error }))
  if (first.answer === 'down')
    return { ...base, problem: `Nothing answered at ${url} (${message('error' in first ? first.error : '')}).` }
  const reachable = { ...base, reachable: true }
  if (first.answer === 'refused' && first.oauth)
    return {
      ...reachable,
      kind: 'mcp',
      auth: { needed: 'oauth', accepted: false },
      problem: null,
    }
  if (first.answer === 'mcp') {
    try {
      const listing = await adapters.for('mcp').list(endpoint('mcp', null), credential)
      return {
        ...reachable,
        kind: 'mcp',
        auth: { needed: given ? 'key' : 'none', accepted: true },
        server: listing.server,
        instructions: listing.instructions,
        toolCount: listing.tools.length,
        tools: previewOf(listing.tools),
        offers: offersOf(listing),
      }
    } catch (error) {
      return {
        ...reachable,
        kind: 'mcp',
        auth: { needed: given ? 'key' : 'none', accepted: false },
        problem: message(error),
      }
    } finally {
      await adapters.forget(probeId)
    }
  }
  const spec = await findSpec(url, headers)
  if (spec) {
    try {
      const listing = await adapters.for('http').list(endpoint('http', { spec }), credential)
      return {
        ...reachable,
        kind: 'http',
        auth: { needed: given ? 'key' : 'none', accepted: true },
        http: { spec },
        server: listing.server,
        instructions: listing.instructions,
        toolCount: listing.tools.length,
        tools: previewOf(listing.tools),
      }
    } catch (error) {
      return { ...reachable, kind: 'http', http: { spec }, problem: message(error) }
    }
  }
  if (first.answer === 'refused')
    return {
      ...reachable,
      auth: { needed: 'key', accepted: false },
      problem: given
        ? 'It refused this key. Check the key and how it is sent (bearer or a named header).'
        : 'It asks for a key. Add one and look again.',
    }
  return {
    ...reachable,
    problem:
      'Neither an MCP server nor an OpenAPI document answered here. Point at the MCP endpoint (often /mcp) or the spec (often /openapi.json).',
  }
}
