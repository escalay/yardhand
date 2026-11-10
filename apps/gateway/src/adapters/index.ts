/**
 * Adapters turn one kind of upstream into tools: list what it offers, call one. The core never talks to an upstream
 * any other way, so a new kind of upstream is one more adapter and nothing else changes.
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/client'
import type { CatalogListing } from '../features/catalog/content.js'
import type { ToolDefinition } from '../features/tools/repo.js'
import { ProblemError } from '../kit/index.js'
import { type ComposioAccount, type ComposioApp, composioAdapter } from './composio.js'
import { httpAdapter } from './http.js'
import { mcpAdapter } from './mcp.js'
import { sampleAdapter } from './sample.js'

export type UpstreamKind = 'mcp' | 'http' | 'composio' | 'sample'
export type AuthKind = 'none' | 'bearer' | 'header' | 'basic' | 'oauth'

/** What an adapter needs to reach an upstream. */
export type Endpoint = {
  id: string
  kind: UpstreamKind
  url: string
  auth: AuthKind
  authHeader: string | null
  config: Record<string, unknown> | null
}
/** The upstream's secret, from the vault: a bearer token, a header value, or `user:password` for basic. */
export type Credential = { value: string }

/** A tool as an upstream lists it; `route` is the HTTP route behind it when the upstream says (kit 1.7.0 `_meta`). */
export type RemoteTool = ToolDefinition & { name: string; route?: string | null }
export type Listing = {
  tools: RemoteTool[]
  instructions: string | null
  server: string | null
  /** Manuals, playbooks and links: what the upstream offers besides tools. */
  catalog: CatalogListing
}
export type ToolResult = {
  content: unknown[]
  structuredContent?: unknown
  isError?: boolean
  /** The upstream asked something mid-call (MCP 2026-07-28 input requests): answer and call again to go on. */
  asked?: Asked
}
/** What an upstream asked mid-call: its requests by key, and its own state to send back with the answers. */
export type Asked = { inputRequests: Record<string, unknown>; requestState?: string }
/** The answers to an upstream's questions, with its state, for the call that goes on. */
export type Resume = { inputResponses: Record<string, unknown>; requestState?: string }
export type Progress = { progress: number; total?: number; message?: string }
/** An open watch on an upstream's change notices. */
export type Watch = { close: () => Promise<void>; closed: Promise<void> }
/** A prompt filled in with arguments: what the upstream would have the agent read. */
export type PromptResult = { description?: string; messages: unknown[] }
/** A resource's contents: text or base64 blobs, each with its URI and type. */
export type ResourceResult = { contents: { uri: string; mimeType?: string; text?: string; blob?: string }[] }

export type Adapter = {
  list: (endpoint: Endpoint, credential: Credential | undefined) => Promise<Listing>
  /** `retry`: may the call be sent again on a fresh connection if the pooled one turns out stale (reads only). */
  call: (
    endpoint: Endpoint,
    credential: Credential | undefined,
    name: string,
    args: Record<string, unknown>,
    options: { retry: boolean; resume?: Resume; onProgress?: (progress: Progress) => void },
  ) => Promise<ToolResult>
  /** A prompt (a playbook) filled in with arguments. */
  getPrompt: (
    endpoint: Endpoint,
    credential: Credential | undefined,
    name: string,
    args: Record<string, string>,
  ) => Promise<PromptResult>
  /** One resource by URI (a link a tool returned, or a listed resource). */
  readResource: (endpoint: Endpoint, credential: Credential | undefined, uri: string) => Promise<ResourceResult>
  /**
   * Listens for the upstream's own change notices (tools, prompts, resources) on a connection of its own, calling
   * `onChange` for each. Resolves `null` when the upstream announces none; otherwise a handle whose `closed`
   * settles when the stream ends, so the caller can listen again.
   */
  watch: (
    endpoint: Endpoint,
    credential: Credential | undefined,
    onChange: (what: 'tools' | 'prompts' | 'resources') => void,
  ) => Promise<Watch | null>
  /** Drops pooled connections, after the endpoint or its credential changed. */
  forget: (upstreamId: string) => Promise<void>
  /** The accounts an upstream holds per app (Composio), for the owner to pick one by its label. */
  accounts?: (endpoint: Endpoint, credential: Credential | undefined) => Promise<ComposioAccount[]>
  /** The apps an upstream lists tools from (Composio), each on or off. */
  apps?: (endpoint: Endpoint, credential: Credential | undefined) => Promise<ComposioApp[]>
}

export const authHeaders = (
  endpoint: Pick<Endpoint, 'auth' | 'authHeader'>,
  credential: Credential | undefined,
): Record<string, string> => {
  // OAuth upstreams authenticate through the SDK's provider, not a header
  if (endpoint.auth === 'none' || endpoint.auth === 'oauth') return {}
  if (!credential?.value)
    throw new ProblemError('upstream', {
      detail: 'This upstream has no credential stored: set one with PATCH /api/upstreams/{id}.',
    })
  if (endpoint.auth === 'bearer') return { authorization: `Bearer ${credential.value}` }
  if (endpoint.auth === 'basic') return { authorization: `Basic ${Buffer.from(credential.value).toString('base64')}` }
  return { [endpoint.authHeader ?? 'x-api-key']: credential.value }
}

export const createAdapters = (
  info: { name: string; version: string },
  oauthProviderFor: (upstreamId: string) => OAuthClientProvider,
  /** The CLI user key a personal Composio upstream reads Composio's tool list with. */
  { composioCatalogKey }: { composioCatalogKey?: string | undefined } = {},
) => {
  const mcp = mcpAdapter(info, oauthProviderFor)
  const byKind: Record<UpstreamKind, Adapter> = {
    mcp,
    http: httpAdapter(),
    composio: composioAdapter({ mcp, catalogKey: composioCatalogKey }),
    sample: sampleAdapter(),
  }
  return {
    for: (kind: string): Adapter => {
      const adapter = byKind[kind as UpstreamKind]
      if (!adapter) throw new ProblemError('bad_request', { detail: `No adapter for upstream kind "${kind}" yet.` })
      return adapter
    },
    // The Composio adapter shares the MCP pool, so each pool is dropped once
    forget: async (upstreamId: string) => {
      for (const adapter of [byKind.mcp, byKind.http]) await adapter.forget(upstreamId)
    },
  }
}

export type Adapters = ReturnType<typeof createAdapters>
