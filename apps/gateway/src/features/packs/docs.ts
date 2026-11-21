/**
 * A pack's own pages at its address: the guide (`/p/<pack>/llms.txt`), the OpenAPI document
 * (`/p/<pack>/openapi.json`) and the docs page (`/p/<pack>/docs`), each describing the pack and nothing else of the
 * gateway. They need credentials that open the pack. What they list is read through the API as the caller, so the
 * rules for what a pack shows (`seenBy`, `shownAs`, `holds`) live in one place. The guide opens on the pack's own
 * skill, read as any read of it is (`reads.packSkill`), so it is in the call log.
 *
 * Each page prints the pack's address into what it returns (the guide's Connect lines, the OpenAPI `servers`, the docs
 * page's document URL), so under a name the pack used to have they send the reader on (308) instead of answering.
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import type { Context, MiddlewareHandler } from 'hono'
import { originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { callerOf, OWNER } from '../clients/principals.js'
import { outsideFences, withoutFrontMatter } from './frontmatter.js'

const MARKDOWN = 'text/markdown; charset=utf-8'
/** Read with credentials, so never kept in a shared cache. */
const PRIVATE = 'private, no-cache'

type PackWords = { name: string; title: string; description: string }
type ToolLine = { name: string; title: string | null; summary: string; needsWrite: boolean }
type PlaybookLine = { name: string; title: string; description: string }
type ManualLine = { name: string; upstream: string; description: string }

/** The routes a pack serves, with the methods its keys use: reading and running, never managing the gateway. */
export const PACK_PATHS: Record<string, string[]> = {
  '/api': ['get'],
  '/api/me': ['get'],
  '/api/tools': ['get'],
  '/api/tools/openapi.json': ['get'],
  '/api/tools/{name}': ['get'],
  '/api/tools/{name}/calls': ['post'],
  '/api/calls': ['get', 'post'],
  '/api/calls/{id}': ['get'],
  '/api/calls/{id}/result': ['get'],
  '/api/upstreams': ['get'],
  '/api/upstreams/{id}': ['get'],
  '/api/playbooks': ['get'],
  '/api/playbooks/{name}': ['get'],
  '/api/playbooks/{name}/messages': ['get'],
  '/api/manuals': ['get'],
  '/api/manuals/{name}': ['get'],
  '/api/links': ['get'],
  '/api/resources': ['get'],
}

type Operation = { tags?: string[] } & Record<string, unknown>
type Paths = Record<string, Record<string, Operation>>
type Tag = { name: string; description?: string }
type OpenApi = {
  info: { title: string; version: string; description?: string }
  paths: Paths
  tags?: Tag[]
  security?: Record<string, string[]>[]
  components: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> } & Record<string, unknown>
} & Record<string, unknown>

/** The gateway's own sign-in for agents: a pack's address takes keys only, so its document doesn't offer it. */
const OAUTH = 'oauth'
type ToolsDoc = { paths: Paths; tags?: Tag[]; components?: { schemas?: Record<string, unknown> } }

/**
 * The gateway's OpenAPI document cut to one pack: the routes a pack serves, one operation per tool of the pack, the
 * pack's title and words, and its own address as the server.
 */
export const packOpenApi = ({
  gateway,
  tools,
  pack,
  url,
}: {
  gateway: OpenApi
  tools: ToolsDoc
  pack: PackWords
  /** The pack's address, `https://gw.example.com/p/<pack>`. */
  url: string
}) => {
  const served = Object.fromEntries(
    Object.entries(PACK_PATHS).flatMap(([path, methods]) => {
      const item = gateway.paths[path]
      const kept = Object.fromEntries(methods.flatMap((method) => (item?.[method] ? [[method, item[method]]] : [])))
      return Object.keys(kept).length ? [[path, kept]] : []
    }),
  ) as Paths
  const paths = { ...served, ...tools.paths }
  const used = new Set(Object.values(paths).flatMap((item) => Object.values(item).flatMap((op) => op.tags ?? [])))
  return {
    ...gateway,
    info: {
      ...gateway.info,
      title: pack.title,
      description: [
        pack.description.trim(),
        `${pack.title} is a pack: a set of tools chosen for one kind of work, served at its own address. This document holds everything that address reaches.`,
        [
          '- **Auth:** `Authorization: Bearer <key>`, a key that opens this pack.',
          '- **Find tools:** `GET /api/tools?q=<what you want to do>`, then `GET /api/tools/{name}` for the input schema.',
          '- **Run one:** `POST /api/calls` with `{ "tool": "<name>", "arguments": { … } }`, or its own operation below.',
          `- **Agent guide:** [llms.txt](${url}/llms.txt). **MCP:** \`${url}/mcp\`.`,
        ].join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    servers: [{ url, description: `The ${pack.title} pack` }],
    externalDocs: {
      url: `${url}/llms.txt`,
      description: `Agent guide to ${pack.title}: how to connect and every tool.`,
    },
    tags: [...(gateway.tags ?? []), ...(tools.tags ?? [])].filter((tag) => used.has(tag.name)),
    paths,
    security: (gateway.security ?? []).filter((scheme) => !(OAUTH in scheme)),
    // The gateway's own schema wins a shared name (CallResult, Problem): the pack's routes are written against it
    components: {
      ...gateway.components,
      schemas: { ...tools.components?.schemas, ...gateway.components.schemas },
      securitySchemes: Object.fromEntries(
        Object.entries(gateway.components.securitySchemes ?? {}).filter(([name]) => name !== OAUTH),
      ),
    },
  }
}

/** `SKILL.md` as a part of the guide: without its front matter, every heading one level down, its code as written. */
const skillSection = (skillMd: string) =>
  outsideFences(withoutFrontMatter(skillMd), (line) => (/^#{1,5}[ \t]/.test(line) ? `#${line}` : line)).trim()

/**
 * The pack's guide for agents, as Markdown: what it is for, its skill when it has one, how to connect and work, and
 * everything it holds.
 */
export const packGuide = ({
  pack,
  url,
  tools,
  playbooks,
  manuals,
  readOnly,
  skill,
}: {
  pack: PackWords
  /** The pack's address, `https://gw.example.com/p/<pack>`. */
  url: string
  tools: ToolLine[]
  /** In the order to print them: the pack's own first, as `GET /api/playbooks` lists them. */
  playbooks: PlaybookLine[]
  manuals: ManualLine[]
  readOnly: boolean
  /** The pack's `SKILL.md` as served ("Working with <Title>"), which becomes a section under the pack's title. */
  skill?: string
}) =>
  [
    `# ${pack.title}`,
    ...(pack.description.trim() ? ['', pack.description.trim()] : []),
    '',
    `${pack.title} is a pack: a set of tools chosen for one kind of work, served at its own address. What is listed here is all this address reaches.`,
    ...(skill ? ['', skillSection(skill)] : []),
    '',
    '## Connect',
    '',
    `- **MCP:** \`${url}/mcp\` (Streamable HTTP), with the key as a bearer token: \`Authorization: Bearer <key>\`.`,
    `- **REST:** \`${url}/api\` with the same header. \`GET ${url}/api\` links to everything.`,
    `- **OpenAPI:** \`${url}/openapi.json\`, rendered at \`${url}/docs\`. Every tool is an operation in it.`,
    '',
    '## How to work',
    '',
    `1. Find a tool by what you want to do: \`search_tools\` over MCP, or \`GET ${url}/api/tools?q=<what you want to do>\`. A search that matches nothing says what the pack covers.`,
    `2. Read its description and input schema: \`describe_tool\`, or \`GET ${url}/api/tools/{name}\`.`,
    `3. Run it: \`call_tool\`, or \`POST ${url}/api/calls\` with \`{ "tool": "<name>", "arguments": { … } }\`.`,
    '',
    'Over MCP the tools below are also listed directly, to call as they are; a key with pins of its own lists only those. Tools marked [changes things] need a key with write scope.',
    ...(readOnly ? ['This key is read-only: tools that change things are left out.'] : []),
    '',
    "The pack sets some inputs of its tools. An input the pack fills itself is not in the tool's schema: leave it out, a call that sends it is refused (400). An input the pack gives a default shows that default in the schema; send your own value to replace it.",
    '',
    `## Tools (${tools.length})`,
    '',
    ...(tools.length
      ? tools.map(
          (tool) =>
            `- \`${tool.name}\`${tool.needsWrite ? ' [changes things]' : ''}: ${tool.title ? `${tool.title}. ` : ''}${tool.summary}`,
        )
      : ['This pack holds no tools this key can use.']),
    ...(playbooks.length
      ? [
          '',
          '## Playbooks',
          '',
          `Step-by-step ways to do one task with these tools: \`get_playbook\` over MCP, or \`GET ${url}/api/playbooks/{name}/messages\`.`,
          '',
          ...playbooks.map((playbook) => `- \`${playbook.name}\`: ${playbook.title}. ${playbook.description}`),
        ]
      : []),
    ...(manuals.length
      ? [
          '',
          '## Manuals',
          '',
          `How a server says its tools are used. Read one once, before its tools: \`read_resource\` over MCP, or \`GET ${url}/api/manuals/{name}\`.`,
          '',
          ...manuals.map(
            (manual) => `- \`${manual.name}\` (\`gateway://u/${manual.upstream}/manual\`): ${manual.description}`,
          ),
        ]
      : []),
    '',
  ].join('\n')

export const mountPackDocs = (app: OpenAPIHono, { principals, reads }: Pick<Services, 'principals' | 'reads'>) => {
  /** The pack this address names, for a caller that opens it; 403 says why not, 404 where no pack is addressed. */
  const packOf = async (c: Context) => {
    const principal = await principals.require(callerOf(c))
    if (!principal.pack || principal.pack.name !== c.req.param('pack'))
      throw new ProblemError('not_found', {
        detail: `Nothing at ${c.req.path}. A pack's pages are at /p/<pack>/docs, /p/<pack>/llms.txt and /p/<pack>/openapi.json.`,
      })
    return principal
  }
  /** The API in-process as this caller, inside the pack the address chose: the same answers its key gets. */
  const readAs = async <T>(c: Context, path: string): Promise<T> => {
    const origin = new URL(originOf(c))
    const forwarded = (['authorization', 'cookie', 'cf-access-jwt-assertion'] as const).flatMap((name) => {
      const value = c.req.header(name)
      return value ? [[name, value]] : []
    })
    const response = await app.request(path, {
      headers: {
        ...Object.fromEntries(forwarded),
        'x-forwarded-proto': origin.protocol.slice(0, -1),
        'x-forwarded-host': origin.host,
      },
    })
    if (!response.ok)
      throw new ProblemError('internal', {
        detail: `This page is built from ${path}, which answered ${response.status}: ask for it directly to see why.`,
      })
    return response.json() as Promise<T>
  }
  const wordsOf = (pack: PackWords): PackWords => ({
    name: pack.name,
    title: pack.title,
    description: pack.description,
  })
  const urlOf = (c: Context, name: string) => `${originOf(c)}/p/${name}`

  /**
   * Sends a reader who came by a former name to the same page under the name the pack has now. A key that does not
   * open the pack gets its 403 first, by the name it asked for: never the new name, never a redirect.
   */
  const sentOn: MiddlewareHandler = async (c, next) => {
    const caller = callerOf(c)
    if (!caller?.pack || caller.cameBy !== c.req.param('pack')) return next()
    await principals.require(caller)
    const rest = c.req.path.replace(/^\/p\/[^/]+/, '')
    c.header('cache-control', PRIVATE)
    return c.redirect(`/p/${caller.pack}${rest}${new URL(c.req.url).search}`, 308)
  }
  for (const page of ['', '/', '/llms.txt', '/openapi.json', '/docs']) app.get(`/p/:pack${page}`, sentOn)

  const front = async (c: Context) => c.redirect(`/p/${(await packOf(c)).pack?.name}/docs`, 302)
  app.get('/p/:pack', front)
  app.get('/p/:pack/', front)

  app.get('/p/:pack/llms.txt', async (c) => {
    const principal = await packOf(c)
    const pack = principal.pack as NonNullable<typeof principal.pack>
    const [tools, playbooks, manuals] = await Promise.all([
      readAs<{ _embedded: { tools: ToolLine[] } }>(c, '/api/tools?limit=5000'),
      readAs<{ _embedded: { playbooks: PlaybookLine[] } }>(c, '/api/playbooks?limit=200'),
      readAs<{ _embedded: { manuals: ManualLine[] } }>(c, '/api/manuals'),
    ])
    // A read like any other of the skill; the owner looking at the guide is not counted among agents' reads
    const skill = pack.skill
      ? await reads.packSkill({ principal, via: principal.id === OWNER.id ? 'app' : 'rest' }).catch(() => undefined)
      : undefined
    const guide = packGuide({
      pack: wordsOf(pack),
      url: urlOf(c, pack.name),
      tools: tools._embedded.tools,
      playbooks: playbooks._embedded.playbooks,
      manuals: manuals._embedded.manuals,
      readOnly: principal.scope === 'read',
      ...(skill ? { skill: skill.text } : {}),
    })
    return c.body(guide, 200, { 'content-type': MARKDOWN, 'cache-control': PRIVATE })
  })

  app.get('/p/:pack/openapi.json', async (c) => {
    const { pack } = await packOf(c)
    const [gateway, tools] = await Promise.all([
      readAs<OpenApi>(c, '/openapi.json'),
      readAs<ToolsDoc>(c, '/api/tools/openapi.json'),
    ])
    const words = wordsOf(pack as NonNullable<typeof pack>)
    return c.json(packOpenApi({ gateway, tools, pack: words, url: urlOf(c, words.name) }), 200, {
      'cache-control': PRIVATE,
    })
  })

  app.get(
    '/p/:pack/docs',
    async (c, next) => {
      await next()
      if (c.res.ok) c.res.headers.set('cache-control', PRIVATE)
    },
    Scalar(async (c) => {
      const { pack } = await packOf(c)
      return {
        url: `/p/${pack?.name}/openapi.json`,
        pageTitle: `${pack?.title} — API`,
        hideClientButton: false,
        defaultOpenAllTags: false,
      }
    }),
  )
}
