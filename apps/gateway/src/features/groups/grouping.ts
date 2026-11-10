/**
 * Filing a connection's tools into groups. A connection's first grouping comes from the model when smart grouping is
 * set up, else from the rules (`tools/groups.ts`); after that only new tools are filed (by the model, else next to
 * their kind), so the owner's switches never move behind their back. A regroup is proposed, previewed, then applied:
 * tools the owner moved, and the tools of groups the owner made, named or switched off, stay as they are. A Composio connection's
 * groups are its apps, named as Composio names them.
 */
import type { Adapters, Credential } from '../../adapters/index.js'
import type { GroupingConfig } from '../ai/config.js'
import { groupByRules, OTHER, ruleGroupOf } from '../tools/groups.js'
import type { LiveTool, ToolsRepo } from '../tools/repo.js'
import type { UpstreamsRepo } from '../upstreams/repo.js'
import { endpointOf } from '../upstreams/sync.js'
import { fileTools, type Proposal, propose } from './smart.js'

export const createGrouping = ({
  tools,
  upstreams,
  adapters,
  credentialOf,
  smart,
  log = (message) => console.log(message),
}: {
  tools: ToolsRepo
  upstreams: UpstreamsRepo
  adapters: Adapters
  credentialOf: (id: string) => Promise<Credential | undefined>
  /** Smart grouping's settings now (Settings › AI over .env). */
  smart: () => Promise<GroupingConfig>
  log?: (message: string) => void
}) => {
  /** A Composio connection's apps, named by Composio (its slug when Composio can't be asked). */
  const appsOf = async (upstreamId: string) => {
    const row = await upstreams.get(upstreamId)
    const adapter = row ? adapters.for(row.kind) : undefined
    if (!row || !adapter?.apps) return []
    return adapter.apps(endpointOf(row), await credentialOf(upstreamId)).catch(() => {
      const config = (row.config ? JSON.parse(row.config) : {}) as { toolkits?: string[]; off?: string[] }
      return (config.toolkits ?? []).map((key) => ({
        key,
        title: key,
        tools: null,
        logo: null,
        on: !config.off?.includes(key),
      }))
    })
  }

  /** Smart grouping's settings when it can run, else null. */
  const ready = async () => {
    const config = await smart()
    return config.ready ? config : null
  }

  /** Writes a grouping: each tool to its group unless the owner moved it, groups the owner made and off ones kept. */
  const apply = async (upstreamId: string, proposal: Proposal, source: 'ai' | 'rules') => {
    const live = new Set((await tools.listLive({ upstreams: [upstreamId], limit: 5000 })).map((tool) => tool.name))
    // Tools the owner moved, tools in a group switched off and tools in a group the owner made or named stay where
    // they are: a regroup never turns one on, and never empties a group that is the owner's
    const held = new Set(
      (await tools.groupsOf(upstreamId))
        .filter((group) => group.off || group.source === 'owner')
        .map((group) => group.key),
    )
    const moved = new Set(
      (await tools.membersOf(upstreamId))
        .filter((row) => row.moved || held.has(row.groupKey))
        .map((row) => row.toolName),
    )
    for (const [position, group] of proposal.entries()) await tools.defineGroup(upstreamId, group, source, position)
    for (const group of proposal)
      for (const tool of group.tools)
        if (live.has(tool) && !moved.has(tool)) await tools.file(tool, upstreamId, group.key)
    // Groups left empty go, unless the owner made them
    const members = await tools.membersOf(upstreamId)
    const used = new Set(members.filter((row) => live.has(row.toolName)).map((row) => row.groupKey))
    const stale = (await tools.groupsOf(upstreamId)).filter((group) => group.source !== 'owner' && !used.has(group.key))
    await tools.removeGroups(
      upstreamId,
      stale.map((group) => group.key),
    )
  }

  /** The model's grouping of a connection, not applied: what a regroup would do. */
  const preview = async (upstreamId: string) => {
    const config = await ready()
    if (!config) return null
    const row = await upstreams.get(upstreamId)
    const live = await tools.listLive({ upstreams: [upstreamId], limit: 5000 })
    return propose(config, { title: row?.title ?? upstreamId, instructions: row?.instructions ?? null }, live, log)
  }

  /** New tools into the groups that exist: by the model when it can, else next to their kind. */
  const fileNew = async (upstreamId: string, unfiled: LiveTool[], known: Set<string>, apps: string[]) => {
    const config = apps.length ? null : await ready()
    if (config) {
      const row = await upstreams.get(upstreamId)
      const groups = (await tools.groupsOf(upstreamId)).map((group) => ({
        key: group.key,
        title: group.title,
        purpose: group.purpose,
      }))
      const withOther = groups.some((group) => group.key === OTHER.key) ? groups : [...groups, OTHER]
      const placed = await fileTools(config, { title: row?.title ?? upstreamId }, withOther, unfiled).catch(
        (error: unknown) => {
          log(`grouping: ${upstreamId} filed by rules (${error instanceof Error ? error.message : String(error)})`)
          return null
        },
      )
      if (placed) {
        if ([...placed.values()].includes(OTHER.key) && !known.has(OTHER.key))
          await tools.ensureGroup(upstreamId, OTHER, 'ai')
        for (const [tool, group] of placed) await tools.file(tool, upstreamId, group)
        return
      }
    }
    for (const tool of unfiled) {
      const group = ruleGroupOf(tool, apps)
      const target = known.has(group.key) ? group : OTHER
      if (!known.has(target.key)) {
        await tools.ensureGroup(upstreamId, target, 'rules')
        known.add(target.key)
      }
      await tools.file(tool.name, upstreamId, target.key)
    }
  }

  /** Files every live tool of a connection that isn't in a group yet. */
  const file = async (upstreamId: string) => {
    const apps = await appsOf(upstreamId)
    for (const app of apps) await tools.ensureGroup(upstreamId, { key: app.key, title: app.title }, 'rules')
    const live = await tools.listLive({ upstreams: [upstreamId], limit: 5000 })
    const unfiled = live.filter((tool) => !tool.group)
    if (!unfiled.length) return { filed: 0 }
    const appKeys = apps.map((app) => app.key)
    const existing = (await tools.groupsOf(upstreamId)).filter((group) => !appKeys.includes(group.key))
    if (!existing.length && !appKeys.length) {
      const smartly = await preview(upstreamId).catch((error: unknown) => {
        log(`grouping: ${upstreamId} grouped by rules (${error instanceof Error ? error.message : String(error)})`)
        return null
      })
      if (smartly) await apply(upstreamId, smartly, 'ai')
      else {
        const { groups, assignments } = groupByRules(live, appKeys)
        await apply(
          upstreamId,
          groups.map((group) => ({
            ...group,
            purpose: null,
            tools: assignments.filter((entry) => entry.group === group.key).map((entry) => entry.tool),
          })),
          'rules',
        )
      }
      return { filed: live.length }
    }
    await fileNew(upstreamId, unfiled, new Set([...existing.map((group) => group.key), ...appKeys]), appKeys)
    return { filed: unfiled.length }
  }

  return { file, appsOf, preview, apply, ready }
}

export type Grouping = ReturnType<typeof createGrouping>
