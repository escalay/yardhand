/**
 * Remote MCP servers over HTTP: Streamable HTTP first, the older SSE transport when a server only speaks that. One
 * pooled connection per upstream; a stale one is dropped and, for reads, the call is sent once more on a fresh one.
 */
import {
  Client,
  type ClientOptions,
  isInputRequiredResult,
  type OAuthClientProvider,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
import { ProblemError } from '../kit/index.js'
import {
  type Adapter,
  authHeaders,
  type Credential,
  type Endpoint,
  type Listing,
  type PromptResult,
  type RemoteTool,
  type ResourceResult,
  type ToolResult,
  type Watch,
} from './index.js'
import { catalogOf, FRESH } from './mcp-catalog.js'

const CALL_TIMEOUT_MS = 120_000
const LIST_TIMEOUT_MS = 30_000

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The route a tool calls (`GET /items/{id}`), when its server publishes one in `_meta` under a `<vendor>/route` key. */
const ROUTE = /^[A-Z]{3,7} \/\S*$/
const routeOf = (meta: Record<string, unknown> | undefined) => {
  const published = Object.entries(meta ?? {}).find(
    ([key, value]) => key.endsWith('/route') && typeof value === 'string' && value.length <= 300 && ROUTE.test(value),
  )
  return published ? (published[1] as string) : null
}

export const mcpAdapter = (
  info: { name: string; version: string },
  /** The OAuth client for upstreams connected with `auth: oauth` (tokens in the vault, refreshed by the SDK). */
  oauthProviderFor: (upstreamId: string) => OAuthClientProvider,
): Adapter => {
  const pool = new Map<string, Promise<Client>>()

  /**
   * Speaks 2026-07-28 when the upstream does (its questions mid-call come back to the pipeline instead of being
   * answered here), 2025 otherwise.
   */
  const MODERN: ClientOptions = {
    versionNegotiation: { mode: 'auto' },
    inputRequired: { autoFulfill: false },
    // The gateway relays questions and model requests to the caller (or answers for one that can't)
    capabilities: { elicitation: { form: {}, url: {} }, sampling: {} },
  }

  const connect = async (
    endpoint: Endpoint,
    credential: Credential | undefined,
    clientOptions: ClientOptions = MODERN,
  ) => {
    const requestInit = { headers: authHeaders(endpoint, credential) }
    const authProvider = endpoint.auth === 'oauth' ? oauthProviderFor(endpoint.id) : undefined
    const options = { requestInit, ...(authProvider ? { authProvider } : {}) }
    const url = new URL(endpoint.url)
    const client = new Client(info, clientOptions)
    try {
      await client.connect(new StreamableHTTPClientTransport(url, options))
      return client
    } catch (streamable) {
      if (streamable instanceof UnauthorizedError || (authProvider && /unauthori[sz]ed|401/i.test(message(streamable))))
        throw new ProblemError('upstream', {
          detail: `${endpoint.id} needs connecting (or reconnecting): the owner runs POST /api/upstreams/${endpoint.id}/connect and approves.`,
        })
      // A server that stumbles on the 2026 probe still speaks 2025 over the same transport
      if (clientOptions.versionNegotiation)
        try {
          const plain = new Client(info, { ...clientOptions, versionNegotiation: { mode: 'legacy' } })
          await plain.connect(new StreamableHTTPClientTransport(url, options))
          return plain
        } catch {}
      const legacy = new Client(info, { ...clientOptions, versionNegotiation: { mode: 'legacy' } })
      try {
        await legacy.connect(new SSEClientTransport(url, options))
        return legacy
      } catch {
        throw new ProblemError('upstream', {
          detail: `Could not connect to ${endpoint.id} (${url.host}): ${message(streamable)}`,
        })
      }
    }
  }

  const drop = async (id: string) => {
    const pending = pool.get(id)
    pool.delete(id)
    const client = await pending?.catch(() => null)
    await client?.close().catch(() => {})
  }

  /** Runs `use` on the pooled client; on failure drops it and, when allowed, tries once more on a new connection. */
  const withClient = async <T>(
    endpoint: Endpoint,
    credential: Credential | undefined,
    retry: boolean,
    use: (client: Client) => Promise<T>,
  ) => {
    const pooled = pool.get(endpoint.id)
    const fresh = !pooled
    const pending = pooled ?? connect(endpoint, credential)
    if (fresh) pool.set(endpoint.id, pending)
    try {
      return await use(await pending)
    } catch (error) {
      await drop(endpoint.id)
      if (fresh || !retry)
        throw error instanceof ProblemError
          ? error
          : new ProblemError('upstream', { detail: `${endpoint.id}: ${message(error)}` })
      const next = connect(endpoint, credential)
      pool.set(endpoint.id, next)
      try {
        return await use(await next)
      } catch (again) {
        await drop(endpoint.id)
        throw again instanceof ProblemError
          ? again
          : new ProblemError('upstream', { detail: `${endpoint.id}: ${message(again)}` })
      }
    }
  }

  return {
    list: (endpoint, credential) =>
      withClient(endpoint, credential, true, async (client): Promise<Listing> => {
        const found: RemoteTool[] = []
        let cursor: string | undefined
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, FRESH)
          for (const tool of page.tools)
            found.push({
              name: tool.name,
              title: tool.title ?? tool.annotations?.title ?? null,
              description: tool.description ?? '',
              inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
              outputSchema: (tool.outputSchema ?? null) as Record<string, unknown> | null,
              annotations: (tool.annotations ?? {}) as Record<string, unknown>,
              route: routeOf(tool._meta),
            })
          cursor = page.nextCursor
        } while (cursor && found.length < 2000)
        const server = client.getServerVersion()
        return {
          tools: found,
          instructions: client.getInstructions() ?? null,
          server: server ? `${server.name} ${server.version ?? ''}`.trim() : null,
          catalog: await catalogOf(client),
        }
      }),
    call: (endpoint, credential, name, args, { retry, resume, onProgress }) =>
      withClient(endpoint, credential, retry, async (client) => {
        const answer: unknown = await client.request(
          { method: 'tools/call', params: { name, arguments: args, ...(resume ?? {}) } },
          {
            timeout: CALL_TIMEOUT_MS,
            allowInputRequired: true,
            ...(onProgress
              ? {
                  onprogress: (progress: { progress: number; total?: number; message?: string }) =>
                    onProgress(progress),
                  resetTimeoutOnProgress: true,
                }
              : {}),
          },
        )
        if (isInputRequiredResult(answer as never)) {
          const asked = answer as { inputRequests?: Record<string, unknown>; requestState?: string }
          return {
            content: [],
            asked: {
              inputRequests: asked.inputRequests ?? {},
              ...(asked.requestState ? { requestState: asked.requestState } : {}),
            },
          }
        }
        return answer as ToolResult
      }),
    getPrompt: (endpoint, credential, name, args) =>
      withClient(
        endpoint,
        credential,
        true,
        async (client) =>
          (await client.getPrompt({ name, arguments: args }, { timeout: LIST_TIMEOUT_MS })) as PromptResult,
      ),
    readResource: (endpoint, credential, uri) =>
      withClient(
        endpoint,
        credential,
        true,
        async (client) => (await client.readResource({ uri }, { timeout: CALL_TIMEOUT_MS })) as ResourceResult,
      ),
    watch: async (endpoint, credential, onChange): Promise<Watch | null> => {
      // Only the notice matters: the sync that follows reads everything again
      const notice = (what: 'tools' | 'prompts' | 'resources') => ({
        autoRefresh: false,
        debounceMs: 0,
        onChanged: () => onChange(what),
      })
      // Notices arrive on a 2026-07-28 listen stream; a 2025-era server sends them only inside a session
      const client = await connect(endpoint, credential, {
        versionNegotiation: { mode: 'auto' },
        listChanged: { tools: notice('tools'), prompts: notice('prompts'), resources: notice('resources') },
      })
      const capabilities = client.getServerCapabilities() ?? {}
      const announces = Boolean(
        capabilities.tools?.listChanged || capabilities.prompts?.listChanged || capabilities.resources?.listChanged,
      )
      if (!announces) {
        await client.close().catch(() => {})
        return null
      }
      const closed = new Promise<void>((resolve) => {
        client.onclose = () => resolve()
        void client.autoOpenedSubscription?.closed.then(() => resolve())
      })
      return { close: () => client.close().catch(() => {}), closed }
    },
    forget: drop,
  }
}
