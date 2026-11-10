/** Pure rules for a connection's tool groups: what a group holds in words, and a tool's switch state. */
import type { Schemas } from '@/api/client'

type Group = Schemas['ToolGroup']
type Tool = Pick<Schemas['ToolCard'], 'access' | 'offBy' | 'needsWrite'>

export const EFFECT_LABEL = { reads: 'Reads', changes: 'Changes things', deletes: 'Deletes' } as const

/** "12 tools · 8 read · 3 change · 1 delete", leaving out the effects it has none of. */
export const groupLine = (group: Pick<Group, 'tools' | 'effects'>) =>
  [
    `${group.tools} tool${group.tools === 1 ? '' : 's'}`,
    group.effects.reads ? `${group.effects.reads} read` : null,
    group.effects.changes ? `${group.effects.changes} change` : null,
    group.effects.deletes ? `${group.effects.deletes} delete` : null,
  ]
    .filter(Boolean)
    .join(' · ')

/** A tool's switch in words, and what the owner can do about it. */
export const toolStateOf = (tool: Tool) => {
  if (tool.offBy === 'group') return { on: false, text: 'Off with its group', action: 'turn-on' as const }
  if (tool.offBy === 'effect') return { on: false, text: 'Off by its effect', action: 'turn-on' as const }
  if (tool.offBy === 'you') return { on: false, text: 'Off (you)', action: 'follow' as const }
  if (tool.access === 'read' || tool.access === 'write')
    return { on: true, text: 'On (you)', action: 'follow' as const }
  return { on: true, text: 'On', action: 'turn-off' as const }
}

/** The access that turns a tool on against its group: `write` if it changes things, else `read`. */
export const onAccessOf = (tool: Pick<Tool, 'needsWrite'>) => (tool.needsWrite ? 'write' : 'read')

/** The tools no effect switch moves, because the owner set them one by one. */
export const yoursLine = (count: number) =>
  `${count} tool${count === 1 ? ' is' : 's are'} set by you, so these switches leave ${count === 1 ? 'it' : 'them'} be.`

/** How a connection's groups were made, said plainly. */
export const groupedByLine = (groupedBy: Schemas['ToolGroups']['groupedBy']) =>
  ({
    rules: 'Grouped by rules: the route a tool calls, else the noun in its name.',
    ai: 'Grouped by a model; new tools are filed into these groups.',
    owner: 'Grouped by you.',
    apps: 'One group per Composio app. An app switched off isn’t fetched at all.',
    mixed: 'Grouped by the model or rules, and by you.',
  })[groupedBy]

type Proposal = Pick<Schemas['Regroup'], 'before' | 'after' | 'kept'>

/**
 * What a regroup would do, group by group: the tools each proposed group would hold, each with the group it comes
 * from when it moves. Tools that stay where they are (the owner moved them, or their group is off) are left out.
 */
export const arrivalsOf = (proposal: Proposal) => {
  const kept = new Set(proposal.kept)
  const was = new Map(proposal.before.flatMap((group) => group.tools.map((tool) => [tool, group] as const)))
  return proposal.after
    .map((group) => ({
      ...group,
      tools: group.tools
        .filter((tool) => !kept.has(tool))
        .map((tool) => {
          const from = was.get(tool)
          return { name: tool, from: from && from.key !== group.key ? from.title : null }
        }),
    }))
    .filter((group) => group.tools.length > 0)
}

/** "8 groups become 4 · 13 tools move", or that nothing would change. */
export const regroupLine = (proposal: Pick<Schemas['Regroup'], 'before' | 'after' | 'moves'>) => {
  const before = proposal.before.filter((group) => group.tools.length).length
  const after = proposal.after.length
  if (!proposal.moves) return 'Nothing would change'
  const groups = before === after ? `${after} groups` : `${before} groups become ${after}`
  return `${groups} · ${proposal.moves === 1 ? '1 tool moves' : `${proposal.moves} tools move`}`
}
