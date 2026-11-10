/** Group handlers (owner only). Every switch tells agents their lists changed: off tools leave them. */
import type { RouteHandler } from '@hono/zod-openapi'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { requireOwner } from '../clients/principals.js'
import { actsAs, effectOf, keyOf, OTHER } from '../tools/groups.js'
import type { routes } from './routes.js'

type Routes = typeof routes
const EFFECTS = ['reads', 'changes', 'deletes'] as const

export const groupsHandlers = ({ tools, upstreams, grouping, sync, adapters, listsChanged }: Services) => {
  const upstreamOf = async (id: string) => {
    const row = await upstreams.get(id)
    if (!row) throw new ProblemError('not_found', { detail: `No connection ${id}. GET /api/upstreams lists them.` })
    return row
  }
  const composioConfigOf = (row: { config: string | null }) =>
    (row.config ? JSON.parse(row.config) : {}) as { toolkits?: string[]; off?: string[]; [key: string]: unknown }

  /** A Composio connection's app list changed: save it, drop pooled connections, fetch again. */
  const setApps = async (id: string, change: (config: ReturnType<typeof composioConfigOf>) => void) => {
    const row = await upstreamOf(id)
    const config = composioConfigOf(row)
    change(config)
    await upstreams.update(id, { config: JSON.stringify(config) })
    await adapters.forget(id)
    await sync(id)
  }

  const viewOf = async (origin: string, id: string) => {
    const row = await upstreamOf(id)
    // Tools not filed yet (an upstream from before groups) are filed on the way
    await grouping.file(id).catch(() => null)
    const [groups, live, effects, apps] = await Promise.all([
      tools.groupsOf(id),
      tools.listLive({ upstreams: [id], limit: 5000 }),
      tools.effectsOf(id),
      grouping.appsOf(id),
    ])
    const appByKey = new Map(apps.map((app) => [app.key, app]))
    const offEffects = new Set(effects.filter((row) => row.off).map((row) => row.effect))
    const shown = groups
      .map((group) => {
        const members = live.filter((tool) => tool.group?.key === group.key)
        const count = (effect: (typeof EFFECTS)[number]) => members.filter((tool) => actsAs(tool) === effect).length
        const app = appByKey.get(group.key)
        return {
          key: group.key,
          title: app?.title ?? group.title,
          purpose: group.purpose,
          source: group.source,
          off: app ? !app.on : group.off,
          tools: members.length,
          offTools: members.filter((tool) => tool.access === 'off').length,
          effects: { reads: count('reads'), changes: count('changes'), deletes: count('deletes') },
          app: app ? { logo: app.logo, available: app.tools, fetched: app.on } : null,
        }
      })
      // An empty group of the rules or a model goes; yours and Composio's apps stay
      .filter((group) => group.tools > 0 || group.app || group.source === 'owner')
    const sources = new Set(groups.filter((group) => !appByKey.has(group.key)).map((group) => group.source))
    return {
      upstream: id,
      groupedBy: (row.kind === 'composio' ? 'apps' : sources.size > 1 ? 'mixed' : ([...sources][0] ?? 'rules')) as
        | 'rules'
        | 'ai'
        | 'owner'
        | 'apps'
        | 'mixed',
      effects: EFFECTS.map((effect) => ({
        effect,
        // What the switch holds: a tool with a setting of its own keeps that setting
        tools: live.filter((tool) => !tool.ownAccess && effectOf(tool) === effect).length,
        off: offEffects.has(effect),
      })),
      yours: live.filter((tool) => tool.ownAccess).length,
      groups: shown,
      smart: Boolean(await grouping.ready()) && row.kind !== 'composio',
      _links: linksOf(origin, { self: `/api/upstreams/${id}/groups`, upstream: `/api/upstreams/${id}` }),
    }
  }

  const list: RouteHandler<Routes['list']> = async (c) => {
    requireOwner(c)
    return c.json(await viewOf(originOf(c), c.req.valid('param').id), 200)
  }

  const create: RouteHandler<Routes['create']> = async (c) => {
    requireOwner(c)
    const { id } = c.req.valid('param')
    const row = await upstreamOf(id)
    const { title, app } = c.req.valid('json')
    if (app) {
      if (row.kind !== 'composio')
        throw new ProblemError('bad_request', { detail: `${id} isn’t a Composio connection: give a title instead.` })
      await setApps(id, (config) => {
        config.toolkits = [...new Set([...(config.toolkits ?? []), app])]
        config.off = (config.off ?? []).filter((key) => key !== app)
      })
      listsChanged({ tools: true })
    } else if (title) {
      const key = keyOf(title)
      if ((await tools.groupsOf(id)).some((group) => group.key === key))
        throw new ProblemError('conflict', { detail: `${id} already has a group called ${title}.` })
      await tools.ensureGroup(id, { key, title }, 'owner')
    } else throw new ProblemError('bad_request', { detail: 'Give a title for a new group, or app for a Composio app.' })
    return c.json(await viewOf(originOf(c), id), 200)
  }

  const update: RouteHandler<Routes['update']> = async (c) => {
    requireOwner(c)
    const { id, key } = c.req.valid('param')
    const row = await upstreamOf(id)
    const { off, title } = c.req.valid('json')
    const group = (await tools.groupsOf(id)).find((entry) => entry.key === key)
    if (!group)
      throw new ProblemError('not_found', { detail: `${id} has no group ${key}. GET its groups to see them.` })
    const isApp = row.kind === 'composio' && composioConfigOf(row).toolkits?.includes(key)
    if (off !== undefined && isApp)
      await setApps(id, (config) => {
        config.off = off ? [...new Set([...(config.off ?? []), key])] : (config.off ?? []).filter((app) => app !== key)
      })
    else if (off !== undefined) await tools.setGroup(id, key, { off })
    if (title !== undefined) await tools.setGroup(id, key, { title })
    listsChanged({ tools: true })
    return c.json(await viewOf(originOf(c), id), 200)
  }

  const remove: RouteHandler<Routes['remove']> = async (c) => {
    requireOwner(c)
    const { id, key } = c.req.valid('param')
    const row = await upstreamOf(id)
    const groups = await tools.groupsOf(id)
    const group = groups.find((entry) => entry.key === key)
    if (!group)
      throw new ProblemError('not_found', { detail: `${id} has no group ${key}. GET its groups to see them.` })
    if (row.kind === 'composio' && composioConfigOf(row).toolkits?.includes(key))
      throw new ProblemError('bad_request', {
        detail: `${group.title} is a Composio app: switch it off instead (PATCH with off: true), and it isn’t fetched.`,
      })
    if (key === OTHER.key)
      throw new ProblemError('bad_request', {
        detail: 'Other holds the tools that fit no group: move them out and it goes by itself.',
      })
    const live = new Set((await tools.listLive({ upstreams: [id], limit: 5000 })).map((tool) => tool.name))
    const members = (await tools.membersOf(id)).filter((member) => member.groupKey === key)
    const held = members.filter((member) => live.has(member.toolName))
    // Deleting an off group would switch its tools on in Other: the owner does that knowingly or not at all
    if (group.off && held.length)
      throw new ProblemError('conflict', {
        detail: `${group.title} is off and holds ${held.length} tool${held.length === 1 ? '' : 's'}: deleting it would switch them on. Turn it on or move its tools first.`,
      })
    if (members.length && !groups.some((entry) => entry.key === OTHER.key)) await tools.ensureGroup(id, OTHER, 'rules')
    for (const member of members) await tools.file(member.toolName, id, OTHER.key)
    await tools.removeGroups(id, [key])
    listsChanged({ tools: true })
    return c.json(await viewOf(originOf(c), id), 200)
  }

  const effect: RouteHandler<Routes['effect']> = async (c) => {
    requireOwner(c)
    const { id, effect: which } = c.req.valid('param')
    await upstreamOf(id)
    await tools.setEffect(id, which, c.req.valid('json').off)
    listsChanged({ tools: true })
    return c.json(await viewOf(originOf(c), id), 200)
  }

  const move: RouteHandler<Routes['move']> = async (c) => {
    requireOwner(c)
    const { name } = c.req.valid('param')
    const tool = await tools.live(name)
    if (!tool) throw new ProblemError('not_found', { detail: `No live tool ${name}. GET /api/tools lists them.` })
    const { group } = c.req.valid('json')
    if (!(await tools.groupsOf(tool.upstreamId)).some((entry) => entry.key === group))
      throw new ProblemError('bad_request', {
        detail: `${tool.upstreamId} has no group ${group}: make it first with POST /api/upstreams/${tool.upstreamId}/groups.`,
      })
    await tools.file(name, tool.upstreamId, group, true)
    listsChanged({ tools: true })
    return c.json(await viewOf(originOf(c), tool.upstreamId), 200)
  }

  const regroup: RouteHandler<Routes['regroup']> = async (c) => {
    requireOwner(c)
    const { id } = c.req.valid('param')
    const row = await upstreamOf(id)
    if (row.kind === 'composio')
      throw new ProblemError('bad_request', {
        detail: `${id} is grouped by its Composio apps: there is nothing to regroup.`,
      })
    const proposal = await grouping.preview(id).catch((error: unknown) => {
      throw new ProblemError('upstream', {
        detail: `The models couldn’t group ${id}: ${error instanceof Error ? error.message : String(error)}`,
      })
    })
    if (!proposal)
      throw new ProblemError('conflict', {
        detail: 'Smart grouping isn’t set up: give it a key in Settings › AI (or GATEWAY_AI_GROUPING_KEY).',
      })
    const [groups, members] = await Promise.all([tools.groupsOf(id), tools.membersOf(id)])
    const live = new Set((await tools.listLive({ upstreams: [id], limit: 5000 })).map((tool) => tool.name))
    const current = new Map(
      members.filter((member) => live.has(member.toolName)).map((member) => [member.toolName, member]),
    )
    const offKeys = new Set(groups.filter((group) => group.off).map((group) => group.key))
    const ownKeys = new Set(groups.filter((group) => group.source === 'owner').map((group) => group.key))
    const kept = [...current.values()]
      .filter((member) => member.moved || offKeys.has(member.groupKey) || ownKeys.has(member.groupKey))
      .map((member) => member.toolName)
    const moves = proposal.flatMap((group) =>
      group.tools.filter((tool) => current.get(tool)?.groupKey !== group.key && !kept.includes(tool)),
    ).length
    return c.json(
      {
        upstream: id,
        before: groups.map((group) => ({
          key: group.key,
          title: group.title,
          off: group.off,
          tools: [...current.values()]
            .filter((member) => member.groupKey === group.key)
            .map((member) => member.toolName),
        })),
        // A group you made or named keeps its name through a regroup
        after: proposal.map((group) => ({
          ...group,
          title: groups.find((entry) => entry.key === group.key && entry.source === 'owner')?.title ?? group.title,
          off: offKeys.has(group.key),
        })),
        moves,
        kept,
      },
      200,
    )
  }

  const apply: RouteHandler<Routes['apply']> = async (c) => {
    requireOwner(c)
    const { id } = c.req.valid('param')
    const row = await upstreamOf(id)
    if (row.kind === 'composio')
      throw new ProblemError('bad_request', { detail: `${id} is grouped by its Composio apps.` })
    const { groups } = c.req.valid('json')
    const live = new Set((await tools.listLive({ upstreams: [id], limit: 5000 })).map((tool) => tool.name))
    const strangers = groups.flatMap((group) => group.tools).filter((tool) => !live.has(tool))
    if (strangers.length)
      throw new ProblemError('bad_request', {
        detail: `Not live tools of ${id}: ${strangers.slice(0, 5).join(', ')}${strangers.length > 5 ? '…' : ''}. Ask for a fresh proposal.`,
      })
    await grouping.apply(
      id,
      groups.map((group) => ({ ...group, key: keyOf(group.key) })),
      'ai',
    )
    listsChanged({ tools: true })
    return c.json(await viewOf(originOf(c), id), 200)
  }

  return { list, create, update, remove, effect, move, regroup, apply }
}
