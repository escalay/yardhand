/** Pack handlers (owner only). Every change tells agents their lists changed: a pack key's tools are the pack. */
import type { RouteHandler } from '@hono/zod-openapi'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import type { ManualContent, PlaybookContent } from '../catalog/content.js'
import { playbookTitleOf } from '../catalog/content.js'
import { OWNER, requireOwner } from '../clients/principals.js'
import { summaryOf } from '../tools/handlers.js'
import { needsWrite } from '../tools/repo.js'
import { type Fixed, fixedOf, fixedProblems, lostInputs } from './entries.js'
import { flagOf, packFlags } from './flags.js'
import type { PackContents } from './repo.js'
import { FLAGS_PATH, PATH, type routes } from './routes.js'
import type { PackRow, PackToolRow } from './schema.js'
import { likelyUses, type Use, usesIn } from './uses.js'

type Routes = typeof routes

/** Every bit of text in a prompt's messages, in order. */
const textOfMessages = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map(textOfMessages).join('\n')
      : value && typeof value === 'object'
        ? Object.entries(value)
            .filter(([key]) => key === 'text' || key === 'content' || key === 'messages')
            .map(([, inner]) => textOfMessages(inner))
            .join('\n')
        : ''

const upstreamOfTool = (name: string) => name.slice(0, name.indexOf('.'))

export const packsHandlers = ({
  packs,
  tools,
  catalog,
  clients,
  upstreams,
  reads,
  meaning,
  listsChanged,
}: Services) => {
  const packOf = async (name: string) => {
    const pack = await packs.get(name)
    if (!pack) throw new ProblemError('not_found', { detail: `No pack ${name}. GET ${PATH} lists them.` })
    return pack
  }

  /**
   * A pack's tools as the board shows them: the name its keys call each, the tool behind it, live text, the pack's
   * wording and fixed inputs, and a flag when the upstream moved on.
   */
  const toolsOf = async (rows: PackToolRow[]) => {
    const live = new Map((await tools.liveMany(rows.map((row) => row.toolName))).map((tool) => [tool.name, tool]))
    return Promise.all(
      rows.map(async (row) => {
        const tool = live.get(row.toolName)
        const flag = flagOf(tool, row.description && row.basedOn ? await tools.version(row.basedOn) : undefined)
        const fixed = fixedOf(row)
        return {
          name: row.name,
          tool: row.toolName,
          alias: row.name === row.toolName ? null : row.name,
          fixed,
          lostInputs: tool ? lostInputs(tool.inputSchema, fixed) : [],
          upstream: tool?.upstreamId ?? upstreamOfTool(row.toolName),
          title: tool?.title ?? null,
          description: row.description ?? tool?.description ?? '',
          upstreamDescription: tool?.description ?? null,
          wording: row.description,
          reason: row.reason,
          via: row.via,
          needsWrite: tool ? needsWrite(tool) : false,
          live: Boolean(tool),
          flag,
        }
      }),
    )
  }

  const itemsOf = async (kind: 'playbook' | 'manual', names: string[]) =>
    Promise.all(
      names.map(async (name) => {
        const item = await catalog.live(kind, name)
        const content = item?.content as PlaybookContent | ManualContent | undefined
        return {
          name,
          upstream: item?.upstreamId ?? null,
          title:
            item && content?.kind === 'playbook'
              ? playbookTitleOf(item.upstreamId, content)
              : content?.kind === 'manual'
                ? `${item?.upstreamId} manual`
                : null,
          description: content ? summaryOf(content.description) : null,
          live: Boolean(item),
        }
      }),
    )

  const cardOf = async (origin: string, pack: PackRow, contents?: PackContents) => {
    const held = contents ?? (await packs.contentsOf(pack))
    const [toolRows, keys, items] = await Promise.all([
      toolsOf(held.tools),
      clients.ofPack(pack.id),
      catalog.liveNames([...held.playbooks, ...held.manuals]),
    ])
    const now = new Date().toISOString()
    const live = keys.filter((key) => !key.expiresAt || key.expiresAt > now)
    return {
      card: {
        name: pack.name,
        title: pack.title,
        description: pack.description,
        counts: { tools: held.tools.length, playbooks: held.playbooks.length, manuals: held.manuals.length },
        upstreams: [
          ...new Set([...toolRows.map((tool) => tool.upstream), ...items.map((item) => item.upstreamId)]),
        ].sort(),
        keys: live.length,
        flags: toolRows.filter((tool) => tool.flag || tool.lostInputs.length).length,
        updatedAt: pack.updatedAt,
        _links: linksOf(origin, { self: `${PATH}/${pack.name}`, list: PATH }),
      },
      held,
      toolRows,
      keys: live,
    }
  }

  const detailOf = async (origin: string, pack: PackRow) => {
    const { card, held, toolRows, keys } = await cardOf(origin, pack)
    return {
      ...card,
      tools: toolRows,
      playbooks: await itemsOf('playbook', held.playbooks),
      manuals: await itemsOf('manual', held.manuals),
      keyList: keys.map((key) => ({
        id: key.id,
        name: key.name,
        scope: key.scope,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
      })),
      createdAt: pack.createdAt,
    }
  }

  /** The upstream's manual: the one named after it, else its first. */
  const manualOf = async (upstreamId: string) => {
    const manuals = await catalog.listLive({ kinds: ['manual'], upstreams: [upstreamId] })
    return (manuals.find((item) => item.name === upstreamId) ?? manuals[0])?.name ?? null
  }

  /** What a playbook uses, read from its text (filled in with placeholders), then likely tools by meaning. */
  const usesOf = async (playbookName: string, inPack: Set<string>) => {
    const item = await catalog.live('playbook', playbookName)
    if (!item)
      throw new ProblemError('not_found', {
        detail: `No playbook ${playbookName}. GET /api/playbooks lists them.`,
      })
    const content = item.content as PlaybookContent
    const placeholders = Object.fromEntries(content.arguments.map((arg) => [arg.name, `<${arg.name}>`]))
    const read = await reads.playbook({ principal: OWNER, via: 'app' }, playbookName, placeholders).catch(() => null)
    const text = `${content.description}\n${read ? textOfMessages(read.result.messages) : ''}`
    const own = await tools.listLive({ upstreams: [item.upstreamId], limit: 2000 })
    const certain = usesIn(text, item.upstreamId, own)
    const enabled = new Set((await upstreams.list()).filter((row) => row.enabled).map((row) => row.id))
    const ranked = meaning
      ? await meaning.names(`${content.title ?? content.prompt}. ${content.description}`, 30).catch(() => [])
      : []
    const reachable = (await tools.liveMany(ranked)).filter(
      (tool) => enabled.has(tool.upstreamId) && tool.access !== 'off',
    )
    const likely = likelyUses(
      reachable.map((tool) => tool.name),
      certain,
      inPack,
    )
    return { item, textRead: Boolean(read), uses: [...certain, ...likely] as Use[] }
  }

  const flags: RouteHandler<Routes['flags']> = async (c) => {
    requireOwner(c)
    const origin = originOf(c)
    const found = (await packFlags({ packs, tools })).map(({ kind, pack, tool, flag }) => ({
      kind,
      pack: pack.name,
      packTitle: pack.title,
      tool: tool.name,
      wording: tool.description ?? '',
      ...flag,
      _links: linksOf(origin, { pack: `${PATH}/${pack.name}`, tool: `/api/tools/${tool.toolName}` }),
    }))
    return c.json(
      { count: found.length, _links: linksOf(origin, { self: FLAGS_PATH }), _embedded: { flags: found } },
      200,
    )
  }

  const list: RouteHandler<Routes['list']> = async (c) => {
    requireOwner(c)
    const origin = originOf(c)
    const cards = await Promise.all((await packs.list()).map(async (pack) => (await cardOf(origin, pack)).card))
    return c.json({ count: cards.length, _links: linksOf(origin, { self: PATH }), _embedded: { packs: cards } }, 200)
  }

  const create: RouteHandler<Routes['create']> = async (c) => {
    requireOwner(c)
    const { name, title, description, playbook } = c.req.valid('json')
    if (await packs.get(name))
      throw new ProblemError('conflict', { detail: `A pack is already named ${name}: pick another name.` })
    const start = playbook ? await usesOf(playbook, new Set()) : null
    const id = await packs.create({ name, title, description })
    if (start && playbook) {
      await packs.addItems(id, 'playbook', [playbook])
      const manual = await manualOf(start.item.upstreamId)
      if (manual) await packs.addItems(id, 'manual', [manual])
      await packs.addTools(
        id,
        start.uses
          .filter((use) => use.reason !== 'meaning')
          .map((use) => ({ name: use.tool, reason: use.reason, via: playbook })),
      )
    }
    listsChanged()
    const pack = await packOf(name)
    return c.json(await detailOf(originOf(c), pack), 201, { location: `${PATH}/${name}` })
  }

  const get: RouteHandler<Routes['get']> = async (c) => {
    requireOwner(c)
    return c.json(await detailOf(originOf(c), await packOf(c.req.valid('param').name)), 200)
  }

  /** Throws 400 naming every fixed value its live tool refuses. */
  const checkFixed = (entries: { tool: { name: string; inputSchema: Record<string, unknown> }; fixed: Fixed }[]) => {
    const problems = entries.flatMap(({ tool, fixed }) => fixedProblems(tool, fixed))
    if (problems.length)
      throw new ProblemError('bad_request', {
        detail: `Fixed inputs don't fit: ${problems.join('; ')}. GET /api/tools/{name} shows each tool's inputs.`,
      })
  }

  /** Throws 400 naming every tool, playbook or manual that isn't live, and every fixed value that doesn't fit. */
  const checkAdds = async (add: {
    tools?: { name: string; fixed?: Fixed | undefined }[]
    playbooks?: string[]
    manuals?: string[]
  }) => {
    const toolNames = add.tools?.map((tool) => tool.name) ?? []
    const liveTools = new Map((await tools.liveMany(toolNames)).map((tool) => [tool.name, tool]))
    const missing = toolNames.filter((name) => !liveTools.has(name))
    for (const [kind, names] of [
      ['playbook', add.playbooks ?? []],
      ['manual', add.manuals ?? []],
    ] as const)
      for (const name of names) if (!(await catalog.live(kind, name))) missing.push(`${kind} ${name}`)
    if (missing.length)
      throw new ProblemError('bad_request', {
        detail: `Not live, so not added: ${missing.join(', ')}. GET /api/tools and /api/playbooks list what is.`,
      })
    checkFixed(
      (add.tools ?? []).flatMap((tool) => {
        const live = liveTools.get(tool.name)
        return live && tool.fixed ? [{ tool: live, fixed: tool.fixed }] : []
      }),
    )
  }

  const update: RouteHandler<Routes['update']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    const { title, description, add, remove } = c.req.valid('json')
    if (add) await checkAdds(add)
    await packs.update(pack.id, {
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
    })
    if (add?.tools?.length)
      await packs.addTools(
        pack.id,
        add.tools.map((tool) => ({
          name: tool.name,
          reason: tool.reason,
          via: tool.via ?? null,
          alias: tool.alias ?? null,
          fixed: tool.fixed ?? null,
        })),
      )
    if (add?.playbooks?.length) await packs.addItems(pack.id, 'playbook', add.playbooks)
    if (add?.manuals?.length) await packs.addItems(pack.id, 'manual', add.manuals)
    if (remove?.tools?.length) await packs.removeTools(pack.id, remove.tools)
    if (remove?.playbooks?.length) await packs.removeItems(pack.id, 'playbook', remove.playbooks)
    if (remove?.manuals?.length) await packs.removeItems(pack.id, 'manual', remove.manuals)
    listsChanged()
    return c.json(await detailOf(originOf(c), await packOf(pack.name)), 200)
  }

  const remove: RouteHandler<Routes['remove']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    const now = new Date().toISOString()
    const live = (await clients.ofPack(pack.id)).filter((key) => !key.expiresAt || key.expiresAt > now)
    if (live.length)
      throw new ProblemError('conflict', {
        detail: `${pack.title} has ${live.length} live key${live.length === 1 ? '' : 's'} (${live.map((key) => key.name).join(', ')}): revoke ${live.length === 1 ? 'it' : 'them'} first.`,
      })
    await packs.remove(pack.id)
    listsChanged()
    return c.body(null, 204)
  }

  /** One of the pack's tools by the name its keys call it; 404 when the pack has no such name. */
  const entryIn = async (pack: PackRow, name: string) => {
    const row = (await packs.contentsOf(pack)).tools.find((tool) => tool.name === name)
    if (!row)
      throw new ProblemError('not_found', {
        detail: `${pack.title} has no tool called ${name}. GET ${PATH}/${pack.name} lists its tools by name.`,
      })
    return row
  }
  const shownEntry = async (pack: PackRow, name: string) => {
    const [shown] = await toolsOf([await entryIn(pack, name)])
    if (!shown) throw new ProblemError('not_found', { detail: `${pack.title} has no tool called ${name}.` })
    return shown
  }

  const wording: RouteHandler<Routes['wording']> = async (c) => {
    requireOwner(c)
    const { name, tool: entryName } = c.req.valid('param')
    const pack = await packOf(name)
    const row = await entryIn(pack, entryName)
    const live = await tools.live(row.toolName)
    const { description } = c.req.valid('json')
    if (description !== null && !live)
      throw new ProblemError('conflict', {
        detail: `${row.toolName} is not live, so there is nothing to word against.`,
      })
    await packs.setWording(pack.id, row.name, description, live?.versionId ?? null)
    listsChanged({ tools: true })
    return c.json(await shownEntry(pack, row.name), 200)
  }

  const entry: RouteHandler<Routes['entry']> = async (c) => {
    requireOwner(c)
    const { name, tool: entryName } = c.req.valid('param')
    const pack = await packOf(name)
    const row = await entryIn(pack, entryName)
    const { alias, fixed } = c.req.valid('json')
    const next = alias === undefined ? row.name : (alias ?? row.toolName)
    if (next !== row.name && (await packs.contentsOf(pack)).tools.some((tool) => tool.name === next))
      throw new ProblemError('conflict', {
        detail: `${pack.title} already has a tool called ${next}: pick another alias.`,
      })
    if (fixed) {
      const live = await tools.live(row.toolName)
      if (!live && Object.keys(fixed).length)
        throw new ProblemError('conflict', {
          detail: `${row.toolName} is not live, so its inputs can't be checked: sync its upstream first.`,
        })
      if (live) checkFixed([{ tool: live, fixed }])
    }
    await packs.setEntry(pack.id, row.name, {
      ...(alias === undefined ? {} : { name: next }),
      ...(fixed === undefined ? {} : { fixed }),
    })
    listsChanged({ tools: true })
    return c.json(await shownEntry(pack, next), 200)
  }

  const uses: RouteHandler<Routes['uses']> = async (c) => {
    requireOwner(c)
    const { name } = c.req.valid('param')
    const { pack: packName } = c.req.valid('query')
    const pack = packName ? await packOf(packName) : undefined
    const inPack = new Set(pack ? (await packs.contentsOf(pack)).tools.map((tool) => tool.toolName) : [])
    const found = await usesOf(name, inPack)
    const byName = new Map((await tools.liveMany(found.uses.map((use) => use.tool))).map((tool) => [tool.name, tool]))
    return c.json(
      {
        playbook: name,
        upstream: found.item.upstreamId,
        textRead: found.textRead,
        manual: await manualOf(found.item.upstreamId),
        uses: found.uses.map((use) => ({
          ...use,
          title: byName.get(use.tool)?.title ?? null,
          summary: summaryOf(byName.get(use.tool)?.description ?? ''),
          inPack: inPack.has(use.tool),
        })),
        _links: linksOf(originOf(c), { playbook: `/api/playbooks/${name}`, packs: PATH }),
      },
      200,
    )
  }

  return { flags, list, create, get, update, remove, wording, entry, uses }
}
