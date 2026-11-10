/**
 * Config: the gateway's settings as one JSON document (upstreams, clients, pins, tool access, packs), never a secret. Kept
 * with the nightly backups and diffable in git; credentials stay in the vault and the key hashes stay in the database.
 */
import { createRoute, z } from '@hono/zod-openapi'
import { problemResponses } from '../../kit/index.js'
import { VERSION } from '../../version.js'
import { requireOwner } from '../clients/principals.js'
import type { Feature } from '../index.js'
import { ALIAS, fixedOf, fixedProblems } from '../packs/entries.js'
import { PACK_REASONS } from '../packs/schema.js'

const TAG = 'Config'
const ConfigSchema = z
  .record(z.string(), z.unknown())
  .openapi('GatewayConfig', { description: 'Upstreams, clients, pins, tool access and packs, without secrets.' })

const route = createRoute({
  method: 'get',
  path: '/api/config',
  operationId: 'exportConfig',
  tags: [TAG],
  summary: 'Export the settings',
  description:
    'Every upstream (without its credential), client (without its key), the global pins, the tool access overrides and every pack with its tools (wording, alias, fixed inputs), playbooks and manuals, as one JSON document (owner only).',
  responses: {
    200: { content: { 'application/json': { schema: ConfigSchema } }, description: 'The settings.' },
    ...problemResponses(401, 403),
  },
})

const ImportSchema = z
  .object({
    upstreams: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
          title: z.string().min(1).max(120),
          kind: z.enum(['mcp', 'http', 'composio', 'sample']),
          url: z.string().url(),
          auth: z.object({
            type: z.enum(['none', 'bearer', 'header', 'basic', 'oauth']),
            header: z.string().max(80).optional(),
          }),
          http: z.record(z.string(), z.unknown()).nullable().optional(),
          composio: z.record(z.string(), z.unknown()).nullable().optional(),
          trust: z.enum(['trusted', 'review']),
          enabled: z.boolean(),
        }),
      )
      .default([]),
    globalPins: z.array(z.string().max(160)).max(40).optional(),
    toolAccess: z.array(z.object({ name: z.string().max(160), access: z.enum(['read', 'write', 'off']) })).default([]),
    packs: z
      .array(
        z.object({
          name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
          title: z.string().min(1).max(120),
          description: z.string().max(8000).default(''),
          tools: z
            .array(
              z.object({
                name: z.string().min(3).max(160),
                reason: z.enum(PACK_REASONS).default('picked'),
                via: z.string().max(160).nullable().default(null),
                wording: z.string().max(8000).nullable().default(null),
                alias: z.string().regex(ALIAS).nullable().default(null),
                fixed: z.record(z.string(), z.unknown()).nullable().default(null),
              }),
            )
            .default([]),
          playbooks: z.array(z.string().min(1).max(160)).default([]),
          manuals: z.array(z.string().min(1).max(160)).default([]),
        }),
      )
      .default([]),
  })
  .passthrough()
  .openapi('GatewayConfigImport', {
    description: 'An export to apply: upstreams, global pins, tool access and packs.',
  })
const ImportResultSchema = z
  .object({
    created: z
      .array(z.string())
      .openapi({ description: 'Upstreams added; those needing a credential wait as failing until PATCHed.' }),
    kept: z.array(z.string()).openapi({ description: 'Upstreams that already existed and were left as they are.' }),
    pins: z.number().int(),
    toolAccess: z.number().int(),
    packs: z
      .object({
        created: z.array(z.string()).openapi({ description: 'Packs added.' }),
        filled: z
          .array(z.string())
          .openapi({ description: 'Packs that existed and gained what they lacked; nothing in them changed.' }),
      })
      .openapi({ description: 'Packs by name.' }),
    skipped: z.array(z.string()).openapi({ description: 'What could not be applied, and why.' }),
  })
  .openapi('GatewayConfigImportResult', { description: 'What the import did.' })

const importRoute = createRoute({
  method: 'post',
  path: '/api/config',
  operationId: 'importConfig',
  tags: [TAG],
  summary: 'Import the settings',
  description:
    'Applies an export (owner only): adds upstreams that are missing (credentials are never in an export, so set them with PATCH /api/upstreams/{id}), then the global pins and tool access for tools that are live, then the packs. A pack that is missing is created; one that exists keeps everything it has and gains the tools, playbooks and manuals it lacks. Only live tools, playbooks and manuals go in, so after an upstream syncs, import again to fill the rest. Imported wording counts as written against the live tool. Clients are not imported: their keys exist only as hashes in the database backups.',
  request: { body: { required: true, content: { 'application/json': { schema: ImportSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: ImportResultSchema } }, description: 'What changed.' },
    ...problemResponses(400, 401, 403),
  },
})

export const feature: Feature = {
  name: 'config',
  tag: { name: TAG, description: 'The gateway’s settings as one JSON document, without secrets.' },
  migrations: [],
  register: (app, { upstreams, clients, tools, sync, packs, catalog }) => {
    app.openapi(route, async (c) => {
      requireOwner(c)
      const rows = await upstreams.list()
      const toolRows = (await Promise.all(rows.map((row) => tools.ofUpstream(row.id)))).flat()
      const config = {
        gateway: 'yardhand',
        version: VERSION,
        exportedAt: new Date().toISOString(),
        upstreams: rows.map((row) => ({
          id: row.id,
          title: row.title,
          kind: row.kind,
          url: row.url,
          auth: { type: row.auth, ...(row.authHeader ? { header: row.authHeader } : {}) },
          http: row.kind !== 'composio' && row.config ? JSON.parse(row.config) : null,
          ...(row.kind === 'composio' && row.config ? { composio: JSON.parse(row.config) } : {}),
          trust: row.trust,
          enabled: row.enabled,
        })),
        clients: await Promise.all(
          (await clients.list()).map(async (row) => ({
            id: row.id,
            name: row.name,
            kind: row.kind,
            scope: row.scope,
            upstreams: await clients.upstreamsOf(row),
            pins: row.ownPins ? await clients.pinsOf(row.id) : null,
            macTools: row.macTools,
            resultCap: row.resultCap,
            pack: row.packId ? ((await packs.byId(row.packId))?.name ?? null) : null,
            packs: (await Promise.all((await clients.packsOf(row)).map((id) => packs.byId(id)))).flatMap(
              (pack) => pack?.name ?? [],
            ),
            expiresAt: row.expiresAt,
            revokedAt: row.revokedAt,
          })),
        ),
        globalPins: await clients.globalPins(),
        toolAccess: toolRows.filter((row) => row.access).map((row) => ({ name: row.name, access: row.access })),
        packs: await Promise.all(
          (await packs.list()).map(async (pack) => {
            const held = await packs.contentsOf(pack)
            return {
              name: pack.name,
              title: pack.title,
              description: pack.description,
              tools: held.tools.map((tool) => ({
                name: tool.toolName,
                reason: tool.reason,
                via: tool.via,
                wording: tool.description,
                alias: tool.name === tool.toolName ? null : tool.name,
                fixed: tool.fixed ? fixedOf(tool) : null,
              })),
              playbooks: held.playbooks,
              manuals: held.manuals,
            }
          }),
        ),
      }
      return c.json(config, 200)
    })

    app.openapi(importRoute, async (c) => {
      requireOwner(c)
      const input = c.req.valid('json')
      const result = {
        created: [] as string[],
        kept: [] as string[],
        pins: 0,
        toolAccess: 0,
        packs: { created: [] as string[], filled: [] as string[] },
        skipped: [] as string[],
      }
      for (const upstream of input.upstreams) {
        if (await upstreams.get(upstream.id)) {
          result.kept.push(upstream.id)
          continue
        }
        await upstreams.create({
          id: upstream.id,
          title: upstream.title,
          kind: upstream.kind,
          url: upstream.url,
          auth: upstream.auth.type,
          authHeader: upstream.auth.header ?? null,
          trust: upstream.trust,
          enabled: upstream.enabled,
          config: upstream.composio
            ? JSON.stringify(upstream.composio)
            : upstream.http
              ? JSON.stringify(upstream.http)
              : null,
        })
        result.created.push(upstream.id)
        // Only an upstream that needs no secret can sync now; the rest wait for their credential
        if (upstream.auth.type === 'none') await sync(upstream.id).catch(() => null)
      }
      for (const { name, access } of input.toolAccess) {
        if (await tools.live(name)) {
          await tools.setAccess(name, access)
          result.toolAccess++
        } else result.skipped.push(`toolAccess ${name}: not live yet (sync its upstream, then import again)`)
      }
      if (input.globalPins) {
        const live = new Set((await tools.liveMany(input.globalPins)).map((tool) => tool.name))
        for (const name of input.globalPins) if (!live.has(name)) result.skipped.push(`pin ${name}: not live yet`)
        await clients.setGlobalPins(input.globalPins.filter((name) => live.has(name)))
        result.pins = live.size
      }
      for (const wanted of input.packs) {
        const existing = await packs.get(wanted.name)
        const packId =
          existing?.id ??
          (await packs.create({ name: wanted.name, title: wanted.title, description: wanted.description }))
        const held = existing ? await packs.contentsOf(existing) : null
        // A pack tool is the name its keys call it: the alias, else the tool's own
        const have = new Set(held?.tools.map((tool) => tool.name))
        const missing = wanted.tools.filter((tool) => !have.has(tool.alias ?? tool.name))
        const live = new Map((await tools.liveMany(missing.map((tool) => tool.name))).map((tool) => [tool.name, tool]))
        const adding: typeof missing = []
        for (const tool of missing) {
          const found = live.get(tool.name)
          const problems = !found ? ['not live yet'] : tool.fixed ? fixedProblems(found, tool.fixed) : []
          if (problems.length)
            result.skipped.push(`pack ${wanted.name} tool ${tool.alias ?? tool.name}: ${problems.join('; ')}`)
          else adding.push(tool)
        }
        const added = await packs.addTools(packId, adding)
        for (const tool of adding)
          if (tool.wording)
            await packs.setWording(
              packId,
              tool.alias ?? tool.name,
              tool.wording,
              live.get(tool.name)?.versionId ?? null,
            )
        let items = 0
        for (const kind of ['playbook', 'manual'] as const) {
          const had = new Set(kind === 'playbook' ? held?.playbooks : held?.manuals)
          const names = (kind === 'playbook' ? wanted.playbooks : wanted.manuals).filter((name) => !had.has(name))
          const liveNames: string[] = []
          for (const name of names)
            if (await catalog.live(kind, name)) liveNames.push(name)
            else result.skipped.push(`pack ${wanted.name} ${kind} ${name}: not live yet`)
          await packs.addItems(packId, kind, liveNames)
          items += liveNames.length
        }
        if (!existing) result.packs.created.push(wanted.name)
        else if (added + items) result.packs.filled.push(wanted.name)
      }
      return c.json(result, 200)
    })
  },
  tools: [],
}
