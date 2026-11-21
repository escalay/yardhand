/**
 * Pack handlers (owner only). Every change tells agents their lists changed: a pack key's tools are the pack. A
 * change to what a pack sets is judged before it is written (`checks.ts`): refused only for what it breaks itself.
 */
import type { RouteHandler } from '@hono/zod-openapi'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import { OWN_NAMES } from '../../mcp/tools.js'
import type { Services } from '../../services.js'
import type { ManualContent, PlaybookContent } from '../catalog/content.js'
import { playbookTitleOf } from '../catalog/content.js'
import { dayOf } from '../clients/lifetimes.js'
import { OWNER, requireOwner } from '../clients/principals.js'
import { KEY_PLACEHOLDER, surfacesOf } from '../clients/setup.js'
import { summaryOf } from '../tools/handlers.js'
import { type LiveTool, needsWrite } from '../tools/repo.js'
import { checkPack, judge, throwOnRefused, writersOf } from './checks.js'
import { defaultsOf, fixedOf, inputProblems, lostInputs, modeOf } from './entries.js'
import { flagOf, packFlags } from './flags.js'
import { noPack } from './names.js'
import type { PackContents } from './repo.js'
import { FLAGS_PATH, PATH, type routes } from './routes.js'
import type { PackRow, PackToolRow } from './schema.js'
import { packStateOf, withEntry, withTools, withVariables } from './state.js'
import { likelyUses, type Use, usesIn } from './uses.js'
import { resolveValue, type Variables, variablesFrom } from './values.js'

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
  calls,
  upstreams,
  reads,
  meaning,
  env,
  listsChanged,
}: Services) => {
  const packOf = async (name: string) => {
    const pack = await packs.get(name)
    if (!pack) throw new ProblemError('not_found', { detail: await noPack(packs, name) })
    return pack
  }

  /** Refuses a new name for a pack tool that every pack connection already has a tool of its own under. */
  const checkName = (pack: PackRow, name: string, toolName: string) => {
    if (OWN_NAMES.has(name))
      throw new ProblemError('bad_request', {
        detail: `${name} is the name of a tool every pack connection has of its own, so ${toolName} can't take it in ${pack.title}: give it another alias.`,
      })
  }

  /**
   * A pack's tools as the board shows them: the name its keys call each, the tool behind it, live text, the pack's
   * wording, who fills each input (as stored, and with the pack's variables filled in), and a flag when the upstream
   * moved on.
   */
  const toolsOf = async (rows: PackToolRow[], variables: Variables) => {
    const live = new Map((await tools.liveMany(rows.map((row) => row.toolName))).map((tool) => [tool.name, tool]))
    return Promise.all(
      rows.map(async (row) => {
        const tool = live.get(row.toolName)
        const flag = flagOf(tool, row.description && row.basedOn ? await tools.version(row.basedOn) : undefined)
        const fixed = fixedOf(row)
        const defaults = defaultsOf(row)
        const problems = tool ? inputProblems(tool, { fixed, defaults }, variables) : []
        const saidOf = (input: string, level: 'error' | 'warning') =>
          problems.find((problem) => problem.input === input && problem.level === level)?.message ?? null
        const required = Array.isArray(tool?.inputSchema.required) ? (tool.inputSchema.required as string[]) : []
        return {
          name: row.name,
          tool: row.toolName,
          alias: row.name === row.toolName ? null : row.name,
          fixed,
          defaults,
          inputs: Object.keys((tool?.inputSchema.properties ?? {}) as object).map((input) => {
            const mode = modeOf({ fixed, defaults }, input)
            const value = mode === 'fixed' ? fixed[input] : mode === 'default' ? defaults[input] : null
            return {
              name: input,
              mode,
              value,
              resolved: mode === 'agent' ? null : resolveValue(value, variables).value,
              required: required.includes(input),
              problem: saidOf(input, 'error'),
              note: saidOf(input, 'warning'),
              unchecked: problems.some((problem) => problem.input === input && problem.code === 'not_checked'),
            }
          }),
          lostInputs: tool ? lostInputs(tool.inputSchema, { ...fixed, ...defaults }) : [],
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

  /** The pack's keys that work now: not revoked and not ended. */
  const liveKeysOf = async (pack: PackRow) => {
    const now = new Date().toISOString()
    return (await clients.ofPack(pack.id)).filter((key) => !key.expiresAt || key.expiresAt > now)
  }

  const cardOf = async (origin: string, pack: PackRow, contents?: PackContents) => {
    const held = contents ?? (await packs.contentsOf(pack))
    const [toolRows, live, items] = await Promise.all([
      toolsOf(held.tools, variablesFrom(held.variables)),
      liveKeysOf(pack),
      catalog.liveNames([...held.playbooks, ...held.manuals]),
    ])
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
        flags: toolRows.filter(
          (tool) => tool.flag || tool.lostInputs.length || tool.inputs.some((input) => input.problem),
        ).length,
        updatedAt: pack.updatedAt,
        _links: linksOf(origin, { self: `${PATH}/${pack.name}`, list: PATH }),
      },
      held,
      toolRows,
      keys: live,
    }
  }

  /** The newest call by any key that opens the pack, live or revoked. */
  const lastCallOf = async (pack: PackRow) => {
    const ids = new Set(await clients.idsOfPack(pack.id))
    return (
      (await calls.lastByClient())
        .filter((row) => ids.has(row.clientId))
        .map((row) => row.lastAt)
        .sort()
        .at(-1) ?? null
    )
  }

  /** The names that still lead to the pack, each with how many of its live keys last came by it. */
  const formerNamesOf = async (pack: PackRow, keys: { id: string }[]) => {
    const live = new Set(keys.map((key) => key.id))
    const notes = (await clients.cameBy(pack.id)).filter((note) => live.has(note.clientId))
    return (await packs.formerNames(pack.id)).map((former) => ({
      name: former.name,
      until: former.until,
      people: notes.filter((note) => note.cameBy === former.name).length,
    }))
  }

  const detailOf = async (origin: string, pack: PackRow) => {
    const { card, held, toolRows, keys } = await cardOf(origin, pack)
    const state = await packStateOf({ packs, tools }, pack, held)
    return {
      ...card,
      tools: toolRows,
      variables: state.variables.map((variable) => ({
        ...variable,
        usedBy: [...new Set(writersOf(state, variable.name).map((writer) => writer.tool))],
      })),
      findings: checkPack(state).map(({ level, code, path, message }) => ({ level, code, path, message })),
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
      triedAt: pack.triedAt,
      lastCallAt: await lastCallOf(pack),
      formerNames: await formerNamesOf(pack, keys),
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

  /** Throws 409 unless a pack can take this name: no pack has it, and it leads to none but `self`. */
  const nameFree = async (name: string, self?: PackRow) => {
    const holder = await packs.holderOf(name)
    if (!holder || holder.pack.id === self?.id) return
    throw new ProblemError('conflict', {
      detail: holder.until
        ? `${name} still leads to ${holder.pack.title} (its name until ${dayOf(holder.until)}), so the people who connect there are not cut off: pick another name, or free it with DELETE ${PATH}/${holder.pack.name}/names/${name}.`
        : `A pack is already named ${name}: pick another name.`,
    })
  }

  /** For a write that failed: the 409 that says so when the name was taken while it ran, else the failure itself. */
  const takenMeanwhile = (name: string, self?: PackRow) => async (error: unknown) => {
    await nameFree(name, self)
    throw error
  }

  const create: RouteHandler<Routes['create']> = async (c) => {
    requireOwner(c)
    const { name, title, description, playbook } = c.req.valid('json')
    await nameFree(name)
    const start = playbook ? await usesOf(playbook, new Set()) : null
    const id = await packs.create({ name, title, description }).catch(takenMeanwhile(name))
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

  const setup: RouteHandler<Routes['setup']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    const origin = originOf(c)
    const baseUrl = `${origin}/p/${pack.name}`
    return c.json(
      {
        pack: pack.name,
        title: pack.title,
        baseUrl,
        mcpUrl: `${baseUrl}/mcp`,
        apiUrl: `${baseUrl}/api`,
        docsUrl: `${baseUrl}/docs`,
        guideUrl: `${baseUrl}/llms.txt`,
        keyPlaceholder: KEY_PLACEHOLDER,
        surfaces: surfacesOf({ origin, kind: 'key', oauth: Boolean(env.OAUTH_SIGNING_KEY), pack: pack.name }),
        _links: linksOf(origin, { self: `${PATH}/${pack.name}/setup`, pack: `${PATH}/${pack.name}` }),
      },
      200,
    )
  }

  /** Throws 400 naming every tool, playbook or manual that isn't live. */
  const checkAdds = async (add: { tools?: { name: string }[]; playbooks?: string[]; manuals?: string[] }) => {
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
    return liveTools
  }

  const update: RouteHandler<Routes['update']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    const { name, title, description, add, remove } = c.req.valid('json')
    const next = name !== undefined && name !== pack.name ? name : null
    // Every check before the first write: a change that is refused leaves the pack, and its name, as they were
    if (next) await nameFree(next, pack)
    const liveTools = add ? await checkAdds(add) : new Map<string, LiveTool>()
    const before = await packStateOf({ packs, tools }, pack)
    const have = new Set(before.tools.map((tool) => tool.name))
    const adding = (add?.tools ?? []).map((tool) => ({ ...tool, as: tool.alias ?? tool.name }))
    // A name the pack already has stays as it is, so only the new ones are this request's to answer for
    const fresh = adding.filter((tool) => !have.has(tool.as))
    for (const tool of fresh) checkName(pack, tool.as, tool.name)
    const after = withTools(
      before,
      adding.map((tool) => ({
        key: tool.as,
        name: tool.as,
        tool: tool.name,
        live: liveTools.get(tool.name) ?? null,
        fixed: tool.fixed ?? {},
        defaults: tool.defaults ?? {},
      })),
      remove?.tools ?? [],
    )
    throwOnRefused(
      judge(
        before,
        after,
        fresh.flatMap((tool) => [`tools.${tool.as}.fixed`, `tools.${tool.as}.defaults`]),
      ).refused,
    )
    // Any key that is not revoked keeps the old name: an ended one can be extended and must find its address
    if (next) {
      await packs.rename(pack, next, (await clients.ofPack(pack.id)).length > 0).catch(takenMeanwhile(next, pack))
      // Back to a name it had: whoever was noted coming by it is at the pack's address again
      await clients.forgetAddress(pack.id, next)
    }
    await packs.update(pack.id, {
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
    })
    if (adding.length)
      await packs.addTools(
        pack.id,
        adding.map((tool) => ({
          name: tool.name,
          reason: tool.reason,
          via: tool.via ?? null,
          alias: tool.alias ?? null,
          fixed: tool.fixed ?? null,
          defaults: tool.defaults ?? null,
        })),
      )
    if (add?.playbooks?.length) await packs.addItems(pack.id, 'playbook', add.playbooks)
    if (add?.manuals?.length) await packs.addItems(pack.id, 'manual', add.manuals)
    if (remove?.tools?.length) await packs.removeTools(pack.id, remove.tools)
    if (remove?.playbooks?.length) await packs.removeItems(pack.id, 'playbook', remove.playbooks)
    if (remove?.manuals?.length) await packs.removeItems(pack.id, 'manual', remove.manuals)
    listsChanged()
    return c.json(await detailOf(originOf(c), await packOf(next ?? pack.name)), 200)
  }

  const remove: RouteHandler<Routes['remove']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    const live = await liveKeysOf(pack)
    if (live.length)
      throw new ProblemError('conflict', {
        detail: `${pack.title} has ${live.length} live key${live.length === 1 ? '' : 's'} (${live.map((key) => key.name).join(', ')}): revoke ${live.length === 1 ? 'it' : 'them'} first.`,
      })
    await packs.remove(pack.id)
    listsChanged()
    return c.body(null, 204)
  }

  const freeName: RouteHandler<Routes['freeName']> = async (c) => {
    requireOwner(c)
    const { name, former } = c.req.valid('param')
    const pack = await packOf(name)
    if (!(await packs.freeName(pack.id, former)))
      throw new ProblemError('not_found', {
        detail: `${pack.title} has no old name ${former}. GET ${PATH}/${pack.name} lists them.`,
      })
    await clients.forgetAddress(pack.id, former)
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
    const [shown] = await toolsOf([await entryIn(pack, name)], variablesFrom(await packs.variablesOf(pack.id)))
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
    const { alias, fixed, defaults } = c.req.valid('json')
    const before = await packStateOf({ packs, tools }, pack)
    const next = alias === undefined ? row.name : (alias ?? row.toolName)
    if (next !== row.name) {
      if (before.tools.some((tool) => tool.name === next))
        throw new ProblemError('conflict', {
          detail: `${pack.title} already has a tool called ${next}: pick another alias.`,
        })
      checkName(pack, next, row.toolName)
    }
    const sets = Object.keys(fixed ?? {}).length + Object.keys(defaults ?? {}).length
    if (sets && !before.tools.find((tool) => tool.key === row.name)?.live)
      throw new ProblemError('conflict', {
        detail: `${row.toolName} is not live, so its inputs can't be checked: sync its upstream first.`,
      })
    const after = withEntry(before, row.name, {
      name: next,
      ...(fixed === undefined ? {} : { fixed: fixed ?? {} }),
      ...(defaults === undefined ? {} : { defaults: defaults ?? {} }),
    })
    // Only the maps this request sends are its own: a rename of a flagged tool still goes through
    throwOnRefused(
      judge(before, after, [
        ...(fixed === undefined ? [] : [`tools.${row.name}.fixed`]),
        ...(defaults === undefined ? [] : [`tools.${row.name}.defaults`]),
      ]).refused,
    )
    await packs.setEntry(pack.id, row.name, {
      ...(alias === undefined ? {} : { name: next }),
      ...(fixed === undefined ? {} : { fixed }),
      ...(defaults === undefined ? {} : { defaults }),
    })
    listsChanged({ tools: true })
    return c.json(await shownEntry(pack, next), 200)
  }

  const variables: RouteHandler<Routes['variables']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    const wanted = c.req.valid('json').variables.map((variable) => ({
      name: variable.name,
      value: variable.value,
      description: variable.description ?? null,
    }))
    const before = await packStateOf({ packs, tools }, pack)
    throwOnRefused(judge(before, withVariables(before, wanted), ['variables']).refused)
    await packs.setVariables(pack.id, wanted)
    // A new value changes the defaults the pack's keys read
    listsChanged({ tools: true })
    return c.json(await detailOf(originOf(c), await packOf(pack.name)), 200)
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

  return { flags, list, create, get, setup, update, remove, freeName, wording, entry, variables, uses }
}
