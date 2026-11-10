/**
 * A stand-in for Composio on a random local port: the REST catalog (`/api/v3/tools`), REST execute and connected
 * accounts behind a project key (`x-api-key`) or a CLI user key (`x-user-api-key`, catalog only), and the hosted MCP
 * (`/mcp`, behind `x-consumer-api-key`) with the two meta-tools the gateway uses. Calls echo what they were given, so
 * a test sees which account and arguments arrived.
 */
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

export const COMPOSIO_KEYS = { personal: 'ck_personal', project: 'ak_project', user: 'uak_user' }

const TOOLS = {
  gmail: [
    {
      slug: 'GMAIL_FETCH_EMAILS',
      name: 'Fetch emails',
      description: 'Fetches emails from the inbox.',
      tags: ['important', 'readOnlyHint', 'openWorldHint'],
      input_parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, max_results: { type: 'integer', default: 10 } },
      },
    },
    {
      slug: 'GMAIL_DELETE_MESSAGE',
      name: 'Delete message',
      description: 'Deletes a message for good.',
      tags: ['destructiveHint', 'openWorldHint'],
      input_parameters: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'] },
    },
    {
      slug: 'GMAIL_OLD_THING',
      name: 'Old thing',
      description: 'Gone soon.',
      tags: ['deprecated'],
      is_deprecated: true,
      input_parameters: { type: 'object', properties: {} },
    },
  ],
  googlecalendar: [
    {
      slug: 'GOOGLECALENDAR_EVENTS_LIST',
      name: 'List events',
      description: 'Lists calendar events.',
      tags: ['readOnlyHint'],
      input_parameters: { type: 'object', properties: { calendar_id: { type: 'string' } } },
    },
  ],
}

const ACCOUNTS = [
  {
    id: 'gmail_work',
    alias: 'Work Email - me@work.test',
    toolkit: 'gmail',
    status: 'ACTIVE',
    is_default: true,
    user_info: { email: 'me@work.test' },
  },
  { id: 'gmail_home', alias: 'Home Email', toolkit: 'gmail', status: 'ACTIVE', is_default: false, user_info: {} },
  { id: 'gcal_work', alias: 'Work Calendar', toolkit: 'googlecalendar', status: 'ACTIVE', is_default: true },
]

export const startComposio = async () => {
  const seen: { slug: string; account: string | null; arguments: unknown; via: 'mcp' | 'rest' }[] = []
  const echo = (slug: string, account: string | null, args: Record<string, unknown>, via: 'mcp' | 'rest') => {
    seen.push({ slug, account, arguments: args, via })
    if (slug === 'GMAIL_DELETE_MESSAGE' && args.message_id === 'missing')
      return { successful: false, data: { status_code: 404 }, error: 'Message missing not found' }
    return { successful: true, data: { slug, account, arguments: args }, error: null }
  }
  const factory = async () => {
    const server = new McpServer({ name: 'composio-stand-in', version: '1.0.0' })
    server.registerTool(
      'COMPOSIO_MULTI_EXECUTE_TOOL',
      {
        description: 'Runs tools.',
        inputSchema: z.object({
          tools: z.array(
            z.object({
              tool_slug: z.string(),
              arguments: z.record(z.string(), z.unknown()),
              account: z.string().optional(),
            }),
          ),
          sync_response_to_workbench: z.boolean(),
          thought: z.string().optional(),
        }),
      },
      async ({ tools }) => {
        const results = tools.map((tool, index) => {
          const response = echo(tool.tool_slug, tool.account ?? null, tool.arguments, 'mcp')
          return { response, error: response.error, tool_slug: tool.tool_slug, index }
        })
        const failed = results.filter((result) => !result.response.successful).length
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                successful: failed === 0,
                data: { results, total_count: results.length, error_count: failed },
                error: failed ? `${failed} out of ${results.length} tools failed` : null,
              }),
            },
          ],
        }
      },
    )
    server.registerTool(
      'COMPOSIO_SEARCH_TOOLS',
      {
        description: 'Searches tools.',
        inputSchema: z.object({
          queries: z.array(z.object({ use_case: z.string(), known_fields: z.string().optional() })),
          session: z.object({ generate_id: z.boolean().optional() }).optional(),
        }),
      },
      async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              successful: true,
              data: {
                results: [],
                toolkit_connection_statuses: ['gmail', 'googlecalendar', 'googledrive'].map((toolkit) => ({
                  toolkit,
                  has_active_connection: true,
                  accounts: ACCOUNTS.filter((account) => account.toolkit === toolkit).map(
                    ({ toolkit: _, ...account }) => account,
                  ),
                })),
              },
            }),
          },
        ],
      }),
    )
    return server
  }
  const handler = createMcpHandler(factory, { responseMode: 'auto' })
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const header = (name: string) => request.headers.get(name)
      if (url.pathname === '/mcp')
        return header('x-consumer-api-key') === COMPOSIO_KEYS.personal
          ? handler.fetch(request)
          : Response.json({ error: { message: 'Invalid consumer key' } }, { status: 401 })
      const project = header('x-api-key') === COMPOSIO_KEYS.project
      if (url.pathname === '/api/v3/tools') {
        if (!project && header('x-user-api-key') !== COMPOSIO_KEYS.user)
          return Response.json({ error: { message: 'No authentication provided' } }, { status: 401 })
        const toolkit = url.searchParams.get('toolkit_slug') as keyof typeof TOOLS
        return Response.json({ items: TOOLS[toolkit] ?? [], next_cursor: null })
      }
      const toolkit = /^\/api\/v3\/toolkits\/([a-z_]+)$/.exec(url.pathname)?.[1]
      if (toolkit && (project || header('x-user-api-key') === COMPOSIO_KEYS.user)) {
        const names: Record<string, string> = { gmail: 'Gmail', googlecalendar: 'Google Calendar', slack: 'Slack' }
        const count = (TOOLS as Record<string, unknown[]>)[toolkit]?.length ?? 100
        return Response.json({
          slug: toolkit,
          name: names[toolkit] ?? toolkit,
          meta: { tools_count: count, logo: null },
        })
      }
      if (!project) return Response.json({ error: { message: 'Invalid API key' } }, { status: 401 })
      const execute = /^\/api\/v3\.1\/tools\/execute\/([A-Z_]+)$/.exec(url.pathname)
      if (execute?.[1] && request.method === 'POST') {
        const body = (await request.json()) as {
          user_id?: string
          connected_account_id?: string
          arguments: Record<string, unknown>
        }
        if (body.user_id !== 'user-1') return Response.json({ error: { message: 'Unknown user' } }, { status: 400 })
        return Response.json(echo(execute[1], body.connected_account_id ?? null, body.arguments, 'rest'))
      }
      if (url.pathname === '/api/v3/connected_accounts') {
        const toolkits = (url.searchParams.get('toolkit_slugs') ?? '').split(',')
        return Response.json({
          items: ACCOUNTS.filter((account) => toolkits.includes(account.toolkit)).map((account) => ({
            id: `ca_${account.id}`,
            alias: account.alias,
            status: account.status,
            is_default: account.is_default,
            toolkit: { slug: account.toolkit },
          })),
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
