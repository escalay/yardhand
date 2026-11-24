/**
 * Config: the gateway's settings as one JSON document (upstreams, clients, pins, tool access, packs), never a secret. Kept
 * with the nightly backups and diffable in git; credentials stay in the vault and the key hashes stay in the database.
 * The playbooks and skill written for a pack ride in it as Markdown files, by path, and the icon the owner set it as
 * its 512 PNG or its monogram's colour.
 */
import { createRoute, z } from '@hono/zod-openapi'
import { ProblemError, problemResponses } from '../../kit/index.js'
import { VERSION } from '../../version.js'
import { type ManualContent, skillPathOf } from '../catalog/content.js'
import { requireOwner } from '../clients/principals.js'
import type { Feature } from '../index.js'
import { basedOnOf, docPathOf, judge, sentenceOf } from '../packs/checks.js'
import { ALIAS, defaultsOf, fixedOf, personOf } from '../packs/entries.js'
import { withoutFrontMatter } from '../packs/frontmatter.js'
import { PALETTE } from '../packs/icon.js'
import { toolRefsIn } from '../packs/playbook.js'
import { PACK_REASONS } from '../packs/schema.js'
import { SKILL_DOC, skillBodyOf, skillFile } from '../packs/skill.js'
import { packStateOf, withDoc, withHeld, withTools, withVariables } from '../packs/state.js'
import { type Scalar, VARIABLE } from '../packs/values.js'

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
    'Every upstream (without its credential), client (without its key), the global pins, the tool access overrides and every pack with its tools (wording, alias, fixed inputs, defaults and inputs filled per person, as written), variables (one only Per person inputs read has a null value), playbooks and manuals, as one JSON document (owner only). The values each person gives a pack’s Per person inputs are not in it. The playbooks and the skill written for a pack are under its `files`, by path: `playbooks/<name>.md` as written and `SKILL.md` as it is read, with its `{{name}}` left as written. Each is a plain Markdown file to keep in git; their older versions are not exported. A pack’s `icon` is null for the monogram of its name, else the icon the owner set: `{ png }`, an upload as its 512 × 512 PNG in base64, or `{ colour }`, its monogram’s colour.',
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
                defaults: z.record(z.string(), z.unknown()).nullable().default(null),
                person: z.record(z.string(), z.unknown()).nullable().default(null),
              }),
            )
            .default([]),
          variables: z
            .array(
              z.object({
                name: z.string().regex(VARIABLE),
                value: z.union([z.string().max(4000), z.number(), z.boolean()]).nullable(),
                description: z.string().max(400).nullable().default(null),
              }),
            )
            .max(100)
            .default([]),
          playbooks: z.array(z.string().min(1).max(160)).default([]),
          manuals: z.array(z.string().min(1).max(160)).default([]),
          files: z.record(z.string().min(1).max(200), z.string().max(200_000)).default({}),
          icon: z
            .union([
              // A 512 PNG in base64: an upload's is well under the 1 MB an upload may be
              z.object({ png: z.string().max(1_400_000) }),
              z.object({ colour: z.enum(PALETTE) }),
            ])
            .nullable()
            .default(null),
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
    'Applies an export (owner only): adds upstreams that are missing (credentials are never in an export, so set them with PATCH /api/upstreams/{id}), then the global pins and tool access for tools that are live, then the packs. A pack that is missing is created; one that exists keeps everything it has and gains the variables, tools, playbooks, manuals and files it lacks. Variables go in first, so a tool’s fixed inputs and defaults are checked with them filled in; a variable or a tool that would leave a value its tool’s live schema refuses is skipped and named. Only live tools, playbooks and manuals go in, so after an upstream syncs, import again to fill the rest. A pack’s `icon` goes in when it has none of its own yet: an uploaded one is drawn again as an upload is, and one that can’t be is skipped and named. Its `files` go in last, each a plain Markdown file by path (`playbooks/<name>.md`, `SKILL.md`), checked as a save of it is: one that names a tool the pack does not have yet, or that the checks refuse, is skipped and named; one the pack already has is kept as it is. Imported wording counts as written against the live tool. Clients are not imported: their keys exist only as hashes in the database backups.',
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
  register: (app, { upstreams, clients, tools, sync, packs, catalog, packIcons }) => {
    const repos = { packs, tools, catalog, upstreams }
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
            app: row.app,
            revokedAt: row.revokedAt,
          })),
        ),
        globalPins: await clients.globalPins(),
        toolAccess: toolRows.filter((row) => row.access).map((row) => ({ name: row.name, access: row.access })),
        packs: await Promise.all(
          (await packs.list()).map(async (pack) => {
            const held = await packs.contentsOf(pack)
            const icon = await packs.iconOf(pack.id)
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
                defaults: tool.defaults ? defaultsOf(tool) : null,
                person: tool.person ? personOf(tool) : null,
              })),
              playbooks: held.playbooks,
              manuals: held.manuals,
              // The skill as it is read, its `{{name}}` left as written; a playbook as written
              files: Object.fromEntries(
                held.docs.map((doc) =>
                  doc.kind === 'skill'
                    ? ['SKILL.md', skillFile(pack, doc.body, {})]
                    : [`playbooks/${doc.name}.md`, doc.body],
                ),
              ),
              // A variable only Per person inputs read goes with no value; people's own values never go
              variables: held.variables.map((variable) => ({
                name: variable.name,
                value: variable.value === null ? null : (JSON.parse(variable.value) as Scalar),
                description: variable.description,
              })),
              // Only an icon the owner set: none is the monogram of the name, wherever it is imported
              icon:
                icon?.source === 'upload' && icon.png512
                  ? { png: icon.png512.toString('base64') }
                  : icon?.colour
                    ? { colour: icon.colour }
                    : null,
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
        const holder = existing ? undefined : await packs.holderOf(wanted.name)
        if (holder) {
          result.skipped.push(
            `pack ${wanted.name}: the name still leads to ${holder.pack.name} (free it with DELETE /api/packs/${holder.pack.name}/names/${wanted.name})`,
          )
          continue
        }
        const packId =
          existing?.id ??
          (await packs.create({ name: wanted.name, title: wanted.title, description: wanted.description }))
        const pack = existing ?? (await packs.byId(packId))
        if (!pack) continue
        const held = existing ? await packs.contentsOf(existing) : null
        // Each addition is judged as a change of its own, so a problem the pack already has never keeps a good one out
        let state = await packStateOf(repos, pack)
        // Variables first: the values of the tools that follow are checked with them filled in
        const declaring: typeof wanted.variables = []
        for (const variable of wanted.variables) {
          if (state.variables.some((known) => known.name === variable.name)) continue
          const after = withVariables(state, [...state.variables, variable])
          const { refused } = judge(state, after, [`variables.${variable.name}`])
          if (refused.length)
            result.skipped.push(`pack ${wanted.name} variable ${variable.name}: ${refused.map(sentenceOf).join('; ')}`)
          else {
            declaring.push(variable)
            state = after
          }
        }
        const variables = await packs.addVariables(packId, declaring)
        // A pack tool is the name its keys call it: the alias, else the tool's own
        const have = new Set(state.tools.map((tool) => tool.name))
        const missing = wanted.tools.filter((tool) => !have.has(tool.alias ?? tool.name))
        const live = new Map((await tools.liveMany(missing.map((tool) => tool.name))).map((tool) => [tool.name, tool]))
        const adding: typeof missing = []
        for (const tool of missing) {
          const as = tool.alias ?? tool.name
          const found = live.get(tool.name)
          const after = withTools(
            state,
            [
              {
                key: as,
                name: as,
                tool: tool.name,
                live: found ?? null,
                fixed: tool.fixed ?? {},
                defaults: tool.defaults ?? {},
                person: tool.person ?? {},
              },
            ],
            [],
          )
          const problems = !found
            ? ['not live yet']
            : judge(state, after, [`tools.${as}.fixed`, `tools.${as}.defaults`, `tools.${as}.person`]).refused.map(
                (finding) => finding.message,
              )
          if (problems.length) result.skipped.push(`pack ${wanted.name} tool ${as}: ${problems.join('; ')}`)
          else {
            adding.push(tool)
            state = after
          }
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
          const manualPaths: string[] = []
          for (const name of names) {
            // The request route refuses this too (`checkAdds`): one name, one playbook
            if (kind === 'playbook' && state.playbooks.some((doc) => doc.name === name)) {
              result.skipped.push(
                `pack ${wanted.name} playbook ${name}: the pack has a playbook of its own called that (rename that one first)`,
              )
              continue
            }
            const item = await catalog.live(kind, name)
            if (!item) result.skipped.push(`pack ${wanted.name} ${kind} ${name}: not live yet`)
            else {
              liveNames.push(name)
              if (kind === 'manual') manualPaths.push(skillPathOf(item.upstreamId, item.content as ManualContent))
            }
          }
          await packs.addItems(packId, kind, liveNames)
          items += liveNames.length
          state = withHeld(state, kind === 'playbook' ? { playbooks: liveNames } : { manualPaths })
        }
        // The pack's own texts last, each judged as a save of it against everything that went in before
        const naming = new Set(wanted.tools.map((tool) => tool.alias ?? tool.name))
        let docs = 0
        for (const [file, text] of Object.entries(wanted.files)) {
          const playbook = /^playbooks\/(.+)\.md$/.exec(file)?.[1]
          const kind = file === 'SKILL.md' ? 'skill' : playbook ? 'playbook' : null
          if (!kind) {
            result.skipped.push(
              `pack ${wanted.name} ${file}: not a file a pack holds (SKILL.md, or playbooks/<name>.md)`,
            )
            continue
          }
          const name = playbook ?? SKILL_DOC
          if (kind === 'skill' ? state.skill : state.playbooks.some((doc) => doc.name === name)) continue
          const body = kind === 'skill' ? skillBodyOf(text) : text
          const after = withDoc(state, kind, name, body)
          const where = docPathOf(kind, name)
          // A tool the export has that is not in yet: the text waits for it, as the tool waits for its connection
          const waiting = toolRefsIn(withoutFrontMatter(body)).filter(
            (word) => naming.has(word) && !after.tools.some((tool) => tool.name === word),
          )
          const { refused } = judge(state, after, [where])
          if (waiting.length)
            result.skipped.push(
              `pack ${wanted.name} ${file}: names ${waiting.join(', ')}, which ${waiting.length === 1 ? 'is' : 'are'} not in the pack yet (import again once its tools are in)`,
            )
          else if (refused.length)
            result.skipped.push(`pack ${wanted.name} ${file}: ${refused.map(sentenceOf).join('; ')}`)
          else {
            await packs.saveDoc(packId, kind, name, { body, basedOn: basedOnOf(after, where), source: 'import' })
            state = after
            docs++
          }
        }
        // Its icon, unless it has one of its own already
        let icons = 0
        if (wanted.icon && !(await packs.iconOf(packId))) {
          const problem = await ('png' in wanted.icon
            ? packIcons.upload(pack, Buffer.from(wanted.icon.png, 'base64'))
            : packIcons.recolour(pack, wanted.icon.colour)
          ).then(
            () => null,
            (error: unknown) => (error instanceof ProblemError ? error.message : Promise.reject(error)),
          )
          if (problem) result.skipped.push(`pack ${wanted.name} icon: ${problem}`)
          else icons++
        }
        if (!existing) result.packs.created.push(wanted.name)
        else if (variables + added + items + docs + icons) result.packs.filled.push(wanted.name)
      }
      return c.json(result, 200)
    })
  },
  tools: [],
}
