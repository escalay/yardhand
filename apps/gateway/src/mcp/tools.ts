/** The meta-tools, resources and prompt: thin calls to the gateway's routes, so MCP and REST always answer the same. */
import { z } from '@hono/zod-openapi'
import { type McpPrompt, type McpResource, type McpTool, mcpResource, mcpTool } from '../kit/mcp/index.js'

type Card = { name: string; title: string | null; summary: string; needsWrite: boolean }
type Detail = {
  name: string
  title: string | null
  description: string
  inputSchema: unknown
  needsWrite: boolean
  upstreamInstructions: string | null
  manual: string | null
}
type Upstream = {
  id: string
  title: string
  toolCount: number
  groups: { title: string; tools: number }[]
  status: string
  instructions: string | null
  offers: { manuals: number; playbooks: number; links: number }
}
type PlaybookHint = { name: string; title: string; description: string }
type Message = { role: string; content: { type: string; text?: string; resource?: { uri?: string; text?: string } } }
type Contents = { uri: string; mimeType: string | null; text: string | null; blob: string | null }[]
type Page = { callId: string; page: number; pages: number; text: string }

const cardLine = (tool: Card) =>
  `${tool.name}${tool.needsWrite ? ' [changes things]' : ''}: ${tool.title ? `${tool.title}. ` : ''}${tool.summary}`
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const toolName = z.string().min(3).max(160)

export const META_TOOLS: McpTool[] = [
  mcpTool({
    name: 'search_tools',
    title: 'Find tools',
    description:
      'Finds tools across every upstream behind this gateway by what you want to do, best match first. Start here for any task, then describe_tool the one you pick.',
    input: z.object({
      query: z
        .string()
        .min(1)
        .max(200)
        .describe('What you want to do, in a few words, e.g. "find a quick dinner recipe".'),
      upstream: z.string().max(40).optional().describe('Only this upstream (ids from list_upstreams).'),
      group: z
        .string()
        .max(60)
        .optional()
        .describe('Only this group of that upstream, by its name in list_upstreams (needs upstream).'),
      limit: z.number().int().min(1).max(50).optional().describe('At most this many (default 20).'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    call: ({ query, upstream, group, limit }) => ({
      path: '/api/tools',
      query: { q: query, upstream, group: upstream ? group : undefined, limit },
    }),
    summarize: (json: { hiddenForScope: number; playbooks: PlaybookHint[]; _embedded: { tools: Card[] } }) => {
      const hidden = json.hiddenForScope
        ? `\n\n${json.hiddenForScope} more matching tools change things and are hidden from this read-only key.`
        : ''
      const playbooks = json.playbooks.length
        ? `\n\nPlaybooks made for this (step-by-step ways to do it with these tools; get_playbook):\n${json.playbooks.map((playbook) => `${playbook.name}: ${playbook.title}. ${playbook.description}`).join('\n')}`
        : ''
      return json._embedded.tools.length
        ? `${json._embedded.tools.map(cardLine).join('\n')}${hidden}${playbooks}\n\nNext: describe_tool with the name you pick, then call_tool.`
        : `No tools match.${hidden}${playbooks} Try other words, or list_upstreams to see what is connected.`
    },
  }),
  mcpTool({
    name: 'describe_tool',
    title: 'Describe a tool',
    description:
      'A tool’s full description and input schema, and how its upstream says to use it. Read this before call_tool.',
    input: z.object({ name: toolName.describe('The tool name from search_tools, `<upstream>.<tool>`.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    call: ({ name }) => ({ path: `/api/tools/${encodeURIComponent(name)}`, query: { view: 'brief' } }),
    summarize: (tool: Detail) =>
      [
        `${tool.name}${tool.title ? ` (${tool.title})` : ''}${tool.needsWrite ? ' [changes things: needs write scope]' : ''}`,
        '',
        tool.description,
        '',
        'Input schema:',
        JSON.stringify(tool.inputSchema),
        ...(tool.upstreamInstructions ? ['', 'From its upstream:', clip(tool.upstreamInstructions, 1200)] : []),
        ...(tool.manual
          ? ['', `Its server has a manual: read it once before using its tools (read_resource "${tool.manual}").`]
          : []),
        '',
        `Next: call_tool with name "${tool.name}" and arguments matching the schema.`,
      ].join('\n'),
  }),
  mcpTool({
    name: 'list_upstreams',
    title: 'Connected upstreams',
    description:
      'The servers behind this gateway that you may use, with their tool counts, their groups of tools (narrow search_tools with one) and how each says it should be used.',
    input: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    call: () => ({ path: '/api/upstreams' }),
    summarize: (json: { _embedded: { upstreams: Upstream[] } }) =>
      json._embedded.upstreams
        .map((row) =>
          [
            `${row.id}: ${row.title}, ${row.toolCount} tools${row.offers.playbooks ? `, ${row.offers.playbooks} playbooks` : ''}${row.status === 'live' ? '' : ` (${row.status})`}`,
            row.offers.manuals
              ? `  Manual: read_resource "gateway://u/${row.id}/manual" before using its tools.`
              : null,
            row.groups.length > 1
              ? `  Groups: ${row.groups.map((group) => `${group.title} (${group.tools})`).join(', ')}`
              : null,
            row.instructions ? `  ${clip(row.instructions.replace(/\s+/g, ' '), 240)}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n') || 'No upstreams yet.',
  }),
  mcpTool({
    name: 'read_resource',
    title: 'Read a manual or a link',
    description:
      'Reads a server’s manual (gateway://u/<upstream>/manual) or a link a tool returned, as it came (cookbook://recipes/123). Read a server’s manual once before using its tools.',
    input: z.object({
      uri: z
        .string()
        .min(3)
        .max(2000)
        .describe('The link as given, or gateway://u/<upstream>/manual for a server’s manual.'),
      upstream: z.string().max(40).optional().describe('Which server, only when two serve links of the same scheme.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    call: ({ uri, upstream }) => ({ path: '/api/resources', query: { uri, upstream } }),
    summarize: (json: { contents: Contents }) =>
      json.contents
        .map((part) =>
          part.text !== null
            ? part.text
            : `[${part.mimeType ?? 'binary'}, ${Math.round(((part.blob?.length ?? 0) * 3) / 4 / 1024)} KB: not text; open it through GET /api/resources?uri=${encodeURIComponent(part.uri)}]`,
        )
        .join('\n\n') || 'The link is empty.',
  }),
  mcpTool({
    name: 'get_playbook',
    title: 'Use a playbook',
    description:
      'A playbook filled in with your arguments: a server’s step-by-step way to do one task with its tools. search_tools suggests them; follow the steps it returns.',
    input: z.object({
      name: z
        .string()
        .min(3)
        .max(128)
        .describe('The playbook name, `<upstream>-<prompt>`, e.g. cookbook-plan-a-dinner.'),
      arguments: z
        .record(z.string(), z.string())
        .optional()
        .describe('Its arguments (all strings), e.g. {"task": "a dinner for six"}.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    call: ({ name, arguments: args }) => ({
      path: `/api/playbooks/${encodeURIComponent(name)}/messages`,
      query: { arguments: args ? JSON.stringify(args) : undefined },
    }),
    summarize: (json: { description: string | null; messages: Message[] }) =>
      [
        ...(json.description ? [json.description, ''] : []),
        ...json.messages.map((message) =>
          message.content.type === 'text'
            ? (message.content.text ?? '')
            : message.content.type === 'resource'
              ? (message.content.resource?.text ?? `[resource ${message.content.resource?.uri ?? ''}]`)
              : `[${message.content.type}]`,
        ),
      ].join('\n'),
  }),
  mcpTool({
    name: 'get_result',
    title: 'Next page of a big result',
    description:
      'A further page of a result that call_tool cut because it was too big. Use the call_id and page from the note at the end of the cut result.',
    input: z.object({
      call_id: z.string().min(3).max(40).describe('The call id from the cut result.'),
      page: z.number().int().min(2).max(10_000).describe('Which page: 2 for the one after the first.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    call: ({ call_id, page }) => ({ path: `/api/calls/${encodeURIComponent(call_id)}/result`, query: { page } }),
    summarize: (json: Page) =>
      `${json.text}\n\n[Page ${json.page} of ${json.pages}.${json.page < json.pages ? ` Next: get_result with call_id "${json.callId}" and page ${json.page + 1}.` : ' That was the last page.'}]`,
  }),
]

export const RESOURCES: McpResource[] = [
  mcpResource({
    name: 'upstream',
    title: 'An upstream and its tools',
    description: 'One upstream: how it says to use it, and every tool it offers here.',
    uriTemplate: 'gateway://upstreams/{id}',
    read: ({ id }) => [
      { path: `/api/upstreams/${encodeURIComponent(id ?? '')}` },
      { path: '/api/tools', query: { upstream: id, limit: 200 } },
    ],
  }),
  mcpResource({
    name: 'tool',
    title: 'A tool',
    description: 'One tool with its full description and input schema.',
    uriTemplate: 'gateway://tools/{name}',
    read: ({ name }) => [{ path: `/api/tools/${encodeURIComponent(name ?? '')}` }],
  }),
]

export const PROMPTS: McpPrompt[] = [
  {
    name: 'use_gateway',
    title: 'Do a task with the gateway’s tools',
    description: 'Starts a task the gateway way: find the right tools, read them, then run them.',
    arguments: z.object({ task: z.string().describe('What you want done.') }),
    text: ({ task }) =>
      [
        `Task: ${task}`,
        '',
        'Use the Yardhand tools. First search_tools for each step of the task, then describe_tool the best match to read its input schema, then call_tool with matching arguments. If a result is cut, page through it with get_result. If nothing fits, say so instead of guessing.',
      ].join('\n'),
  },
]
