/**
 * Composio as an upstream: the real tools of the toolkits chosen on the upstream (gmail, googlecalendar, slack…),
 * each named after its slug (`gmail_fetch_emails`) with Composio's own title and hints, and the account picked on
 * every call. Two ways in:
 *
 * - `personal`: a personal key (`ck_`, dashboard Settings → Sessions & API Key) reaches the labelled accounts
 *   through Composio's hosted MCP. Its tool list comes from the REST catalog, read with a CLI user key
 *   (`COMPOSIO_API_KEY`, from `composio login`), because the personal key opens only the hosted MCP.
 * - `project`: a project key (`x-api-key`, a project's Settings → API Keys) and the user id that owns the accounts,
 *   through the documented REST API for both.
 *
 * Every tool takes one `account` input (an account's id or label; left out, Composio uses the default account), so a
 * pack fixes the account the same way in both modes.
 */
import { EMPTY_LISTING } from '../features/catalog/content.js'
import { ProblemError } from '../kit/index.js'
import type { Adapter, Credential, Endpoint, RemoteTool, ToolResult } from './index.js'

export type ComposioConfig = {
  mode: 'personal' | 'project'
  /** Toolkit slugs whose tools the upstream lists. */
  toolkits: string[]
  /** Of those, the apps switched off: their tools aren't fetched at all. */
  off?: string[]
  /** For `project`: the Composio user that owns the accounts. */
  userId?: string
  /** Where the REST catalog lives (a stand-in in tests). */
  catalogUrl?: string
}

/** One of the upstream's apps, as Composio names it, with how many tools it has. */
export type ComposioApp = { key: string; title: string; tools: number | null; logo: string | null; on: boolean }

/** One account Composio holds for a toolkit, as the owner picks it. */
export type ComposioAccount = {
  id: string
  label: string
  toolkit: string
  status: string
  isDefault: boolean
  email: string | null
}

export const ACCOUNT_INPUT = 'account'
export const COMPOSIO_REST = 'https://backend.composio.dev'
export const COMPOSIO_MCP = 'https://connect.composio.dev/mcp'
const EXECUTE = 'COMPOSIO_MULTI_EXECUTE_TOOL'
const SEARCH = 'COMPOSIO_SEARCH_TOOLS'
const TIMEOUT_MS = 30_000

type CatalogTool = {
  slug: string
  name: string
  description?: string
  input_parameters?: Record<string, unknown>
  tags?: string[]
  is_deprecated?: boolean
}

const configOf = (endpoint: Endpoint): ComposioConfig => {
  const config = (endpoint.config ?? {}) as Partial<ComposioConfig>
  return {
    mode: config.mode === 'project' ? 'project' : 'personal',
    toolkits: config.toolkits ?? [],
    off: config.off ?? [],
    ...(config.userId ? { userId: config.userId } : {}),
    ...(config.catalogUrl ? { catalogUrl: config.catalogUrl } : {}),
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** JSON from Composio's REST API, or a problem saying what it answered. */
const fetchJson = async (url: string, headers: Record<string, string>, init: RequestInit = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', ...headers, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((error) => {
    throw new ProblemError('upstream', { detail: `Composio could not be reached: ${message(error)}` })
  })
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    const error = (body?.error ?? {}) as { message?: string }
    throw new ProblemError('upstream', {
      detail: `Composio answered ${response.status}: ${error.message ?? (typeof body?.error === 'string' ? body.error : 'no reason given')}`,
    })
  }
  return body ?? {}
}

/** Composio's tags as MCP hints: `readOnlyHint`, `destructiveHint`, `idempotentHint`; create and update tags change things. */
export const hintsOf = (tags: string[] = [], title?: string) => ({
  ...(title ? { title } : {}),
  readOnlyHint: tags.includes('readOnlyHint'),
  destructiveHint: tags.includes('destructiveHint'),
  idempotentHint: tags.includes('idempotentHint'),
  openWorldHint: true,
})

/** The tool's schema with the `account` input every Composio tool takes (unless it has one of its own). */
const withAccount = (schema: Record<string, unknown> | undefined, toolkit: string, upstreamId: string) => {
  const base = schema ?? { type: 'object', properties: {} }
  const properties = (base.properties ?? {}) as Record<string, unknown>
  if (ACCOUNT_INPUT in properties) return base
  return {
    ...base,
    type: 'object',
    properties: {
      ...properties,
      [ACCOUNT_INPUT]: {
        type: 'string',
        description: `Which ${toolkit} account: its id or label, as GET /api/upstreams/${upstreamId}/accounts lists them. Left out, Composio uses the default account.`,
      },
    },
  }
}

export const toolOf = (item: CatalogTool, toolkit: string, upstreamId: string): RemoteTool => ({
  name: item.slug.toLowerCase(),
  title: item.name,
  description: item.description ?? item.name,
  inputSchema: withAccount(item.input_parameters, toolkit, upstreamId),
  outputSchema: null,
  annotations: hintsOf(item.tags, item.name),
  route: null,
})

/** What Composio said a tool did, as a tool result: its data as JSON text (and typed), or its error. */
export const outcomeOf = (successful: boolean, data: unknown, error: unknown): ToolResult =>
  successful
    ? {
        content: [{ type: 'text', text: JSON.stringify(data ?? null, null, 1) }],
        ...(data && typeof data === 'object' && !Array.isArray(data) ? { structuredContent: data } : {}),
      }
    : {
        isError: true,
        content: [
          { type: 'text', text: typeof error === 'string' && error ? error : 'Composio said the call failed.' },
        ],
      }

/** The JSON a hosted-MCP meta-tool answered with, from its text block. */
const answerOf = (result: ToolResult) => {
  const block = (result.content as { type?: string; text?: string }[]).find((part) => part.type === 'text')
  try {
    return JSON.parse(block?.text ?? '') as Record<string, unknown>
  } catch {
    throw new ProblemError('upstream', {
      detail: `Composio's hosted MCP answered something that isn't JSON: ${(block?.text ?? '').slice(0, 200)}`,
    })
  }
}

export const composioAdapter = ({ mcp, catalogKey }: { mcp: Adapter; catalogKey?: string | undefined }): Adapter => {
  /** The hosted MCP, signed in with the personal key the upstream keeps as its credential. */
  const hosted = (endpoint: Endpoint): Endpoint => ({ ...endpoint, kind: 'mcp' })
  const catalogHeaders = (config: ComposioConfig, credential: Credential | undefined): Record<string, string> => {
    if (config.mode === 'project') {
      if (!credential?.value)
        throw new ProblemError('upstream', {
          detail: 'This Composio upstream has no project key stored: set one with PATCH /api/upstreams/{id}.',
        })
      return { 'x-api-key': credential.value }
    }
    if (!catalogKey)
      throw new ProblemError('upstream', {
        detail:
          "A personal Composio upstream reads Composio's tool list with a CLI user key: set COMPOSIO_API_KEY in the gateway's environment (composio login keeps it in ~/.composio/user_data.json).",
      })
    return { 'x-user-api-key': catalogKey }
  }
  const toolkitTools = async (base: string, headers: Record<string, string>, toolkit: string) => {
    const found: CatalogTool[] = []
    let cursor: string | null = null
    do {
      const query = new URLSearchParams({ toolkit_slug: toolkit, toolkit_versions: 'latest', limit: '500' })
      if (cursor) query.set('cursor', cursor)
      const page = (await fetchJson(`${base}/api/v3/tools?${query}`, headers)) as {
        items?: CatalogTool[]
        next_cursor?: string | null
      }
      found.push(...(page.items ?? []))
      cursor = page.next_cursor ?? null
    } while (cursor && found.length < 3000)
    return found.filter((item) => !item.is_deprecated)
  }
  /** Calls one of the hosted MCP's meta-tools and reads its JSON answer. */
  const meta = async (
    endpoint: Endpoint,
    credential: Credential | undefined,
    name: string,
    args: Record<string, unknown>,
    retry: boolean,
  ) => answerOf(await mcp.call(hosted(endpoint), credential, name, args, { retry }))

  return {
    list: async (endpoint, credential) => {
      const config = configOf(endpoint)
      if (!config.toolkits.length)
        throw new ProblemError('bad_request', {
          detail: `Choose the toolkits ${endpoint.id} lists: PATCH /api/upstreams/${endpoint.id} with composio.toolkits, e.g. ["gmail", "googlecalendar"].`,
        })
      const headers = catalogHeaders(config, credential)
      const base = config.catalogUrl ?? COMPOSIO_REST
      const on = config.toolkits.filter((toolkit) => !config.off?.includes(toolkit))
      const perToolkit = await Promise.all(
        on.map(async (toolkit) =>
          (await toolkitTools(base, headers, toolkit)).map((item) => toolOf(item, toolkit, endpoint.id)),
        ),
      )
      return {
        tools: perToolkit.flat(),
        instructions: [
          `Composio: the owner's connected apps (${on.join(', ')}). Every tool takes \`${ACCOUNT_INPUT}\`, the account to use (an id or label; left out, the default account).`,
          'Results are Composio’s data as JSON.',
        ].join(' '),
        server: `Composio (${config.mode})`,
        catalog: EMPTY_LISTING,
      }
    },
    call: async (endpoint, credential, name, args, { retry }) => {
      const config = configOf(endpoint)
      const { [ACCOUNT_INPUT]: account, ...rest } = args
      const slug = name.toUpperCase()
      if (config.mode === 'project') {
        const answer = await fetchJson(
          `${endpoint.url.replace(/\/$/, '')}/api/v3.1/tools/execute/${encodeURIComponent(slug)}`,
          catalogHeaders(config, credential),
          {
            method: 'POST',
            body: JSON.stringify({
              ...(config.userId ? { user_id: config.userId } : {}),
              ...(typeof account === 'string' && account ? { connected_account_id: account } : {}),
              arguments: rest,
            }),
          },
        )
        return outcomeOf(answer.successful === true, answer.data, answer.error)
      }
      const answer = await meta(
        endpoint,
        credential,
        EXECUTE,
        {
          tools: [{ tool_slug: slug, arguments: rest, ...(typeof account === 'string' && account ? { account } : {}) }],
          sync_response_to_workbench: false,
          thought: `${slug} through Yardhand`,
        },
        retry,
      )
      const data = (answer.data ?? {}) as { results?: { response?: Record<string, unknown>; error?: unknown }[] }
      const first = data.results?.[0]
      const response = first?.response
      return outcomeOf(
        (response?.successful ?? answer.successful) === true,
        response?.data,
        response?.error ?? first?.error ?? answer.error,
      )
    },
    accounts: async (endpoint, credential) => {
      const config = configOf(endpoint)
      if (config.mode === 'project') {
        const query = new URLSearchParams({ toolkit_slugs: config.toolkits.join(','), limit: '200' })
        if (config.userId) query.set('user_ids', config.userId)
        const page = (await fetchJson(
          `${endpoint.url.replace(/\/$/, '')}/api/v3/connected_accounts?${query}`,
          catalogHeaders(config, credential),
        )) as {
          items?: {
            id: string
            alias?: string | null
            word_id?: string | null
            status?: string
            is_default?: boolean
            toolkit?: { slug?: string }
          }[]
        }
        return (page.items ?? []).map((item) => ({
          id: item.id,
          label: item.alias ?? item.word_id ?? item.id,
          toolkit: item.toolkit?.slug ?? '',
          status: item.status ?? 'UNKNOWN',
          isDefault: Boolean(item.is_default),
          email: null,
        }))
      }
      // The hosted MCP says which accounts each toolkit has alongside a search: one query per toolkit
      const answer = await meta(
        endpoint,
        credential,
        SEARCH,
        {
          queries: config.toolkits.map((toolkit) => ({
            use_case: `use ${toolkit}`,
            known_fields: `toolkit: ${toolkit}`,
          })),
          session: { generate_id: true },
        },
        true,
      )
      const statuses = ((answer.data ?? {}) as { toolkit_connection_statuses?: unknown[] }).toolkit_connection_statuses
      const wanted = new Set(config.toolkits)
      return ((statuses ?? []) as { toolkit: string; accounts?: Record<string, unknown>[] }[])
        .filter((status) => wanted.has(status.toolkit))
        .flatMap((status) =>
          (status.accounts ?? []).map((account) => ({
            id: String(account.id),
            label: String(account.alias ?? account.id),
            toolkit: status.toolkit,
            status: String(account.status ?? 'UNKNOWN'),
            isDefault: Boolean(account.is_default),
            email:
              typeof (account.user_info as { email?: unknown } | undefined)?.email === 'string'
                ? ((account.user_info as { email: string }).email ?? null)
                : null,
          })),
        )
    },
    apps: async (endpoint, credential) => {
      const config = configOf(endpoint)
      const headers = catalogHeaders(config, credential)
      const base = config.catalogUrl ?? COMPOSIO_REST
      return Promise.all(
        config.toolkits.map(async (toolkit) => {
          const about = (await fetchJson(`${base}/api/v3/toolkits/${encodeURIComponent(toolkit)}`, headers).catch(
            () => ({}),
          )) as { name?: string; meta?: { tools_count?: number; logo?: string } }
          return {
            key: toolkit,
            title: about.name ?? toolkit,
            tools: about.meta?.tools_count ?? null,
            logo: about.meta?.logo ?? null,
            on: !config.off?.includes(toolkit),
          }
        }),
      )
    },
    getPrompt: async () => {
      throw new ProblemError('not_found', { detail: 'Composio upstreams have no playbooks.' })
    },
    readResource: async () => {
      throw new ProblemError('not_found', { detail: 'Composio upstreams have no links to read.' })
    },
    watch: async () => null,
    forget: (upstreamId) => mcp.forget(upstreamId),
  }
}
