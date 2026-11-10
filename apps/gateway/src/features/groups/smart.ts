/**
 * Smart grouping: the writer reads a connection's tools and names its groups (3–15 tools each, at most 12, each with a
 * line on what it is for); the decider files every tool in one of them, 25 questions a call. What that leaves over
 * (groups under three tools, and Other when it is large) gets one more round: the writer names broader groups for the
 * leftovers and the decider files only those. New tools later are filed by the decider into the groups that exist.
 * A Composio connection is never regrouped: its groups are its apps.
 */
import { AiError, chatJson, decide } from '../ai/clients.js'
import type { GroupingConfig } from '../ai/config.js'
import { type GroupDraft, keyOf, OTHER } from '../tools/groups.js'
import type { LiveTool } from '../tools/repo.js'

export const MAX_GROUPS = 12
export const MIN_TOOLS = 3
/** Leftovers worth new groups of their own: enough for two. */
const LEFTOVER = MIN_TOOLS * 2
const BATCH = 25

/** A proposed grouping: each group with the tools filed in it. */
export type Proposal = (GroupDraft & { purpose: string | null; tools: string[] })[]

const summaryOf = (tool: Pick<LiveTool, 'name' | 'title' | 'description'>) =>
  `${tool.name.slice(tool.name.indexOf('.') + 1)}${tool.title ? ` (${tool.title})` : ''}: ${tool.description.replace(/\s+/g, ' ').slice(0, 160)}`

const NAMING = [
  'Name a group after the thing its tools work on, never after the action: not "Search Tools", "Similarity" or',
  '"Comparisons". A tool that searches or suggests menus belongs with Menus. Titles are 1–3 plain words, plural nouns',
  `where natural. Never make a group you can’t fill with ${MIN_TOOLS} tools: put small kinds that belong together in one`,
  'broader group ("Invoices" and "Payments" become "Billing"). Give each a one-line purpose saying what its',
  'tools are for. Keys are lowercase words joined by "-".',
].join(' ')

const WRITER_SYSTEM = [
  'You organise one server’s tools into groups an owner switches on and off together.',
  `Make at most ${MAX_GROUPS} groups of ${MIN_TOOLS} to 15 tools each.`,
  NAMING,
  'Tools that fit nowhere go to the group with key "other".',
  'Reply as JSON: {"groups": [{"key": "...", "title": "...", "purpose": "..."}]}',
].join(' ')

const MORE_SYSTEM = [
  'You organise one server’s tools into groups an owner switches on and off together.',
  `These tools were left without a group. Make groups for them, each holding at least ${MIN_TOOLS} of these tools.`,
  NAMING,
  'Don’t repeat a group that exists. A tool that still fits nowhere needs no group.',
  'Reply as JSON: {"groups": [{"key": "...", "title": "...", "purpose": "..."}]}',
].join(' ')

type Named = { groups?: { key?: string; title?: string; purpose?: string }[] }

/** A model's groups, cleaned: a title each, keys unique and none of the `taken`. */
const cleaned = (answer: Named, taken: string[] = []): GroupDraft[] => {
  const seen = new Set([OTHER.key, ...taken])
  return (answer.groups ?? [])
    .filter((group) => group.title?.trim())
    .map((group) => ({
      key: keyOf(group.key || group.title || ''),
      title: (group.title ?? '').trim().slice(0, 60),
      purpose: group.purpose?.trim().slice(0, 200) || null,
    }))
    .filter((group) => !seen.has(group.key) && seen.add(group.key))
}

const OTHER_GROUP: GroupDraft = { ...OTHER, purpose: 'Tools that fit no other group.' }

/** The writer's groups for these tools, cleaned: unique keys, at most 12, Other last. */
export const nameGroups = async (
  config: GroupingConfig,
  connection: { title: string; instructions: string | null },
  tools: LiveTool[],
): Promise<GroupDraft[]> => {
  const answer = await chatJson<Named>(
    config,
    config.writerModel.value,
    WRITER_SYSTEM,
    [
      `Server: ${connection.title}`,
      connection.instructions ? `It says: ${connection.instructions.replace(/\s+/g, ' ').slice(0, 400)}` : null,
      `Its ${tools.length} tools:`,
      ...tools.map((tool) => `- ${summaryOf(tool)}`),
    ]
      .filter(Boolean)
      .join('\n'),
  )
  const groups = cleaned(answer).slice(0, MAX_GROUPS)
  if (!groups.length) throw new AiError(`${config.writerModel.value} proposed no groups.`)
  return [...groups, OTHER_GROUP]
}

/** The writer's groups for tools the first round left over, beside the groups that hold. */
const nameMore = async (
  config: GroupingConfig,
  connection: { title: string },
  kept: GroupDraft[],
  leftover: LiveTool[],
): Promise<GroupDraft[]> => {
  const answer = await chatJson<Named>(
    config,
    config.writerModel.value,
    MORE_SYSTEM,
    [
      `Server: ${connection.title}`,
      kept.length ? `Groups that exist: ${kept.map((group) => group.title).join(', ')}` : null,
      `The ${leftover.length} tools left over:`,
      ...leftover.map((tool) => `- ${summaryOf(tool)}`),
    ]
      .filter(Boolean)
      .join('\n'),
  )
  return cleaned(
    answer,
    kept.map((group) => group.key),
  ).slice(0, Math.max(0, MAX_GROUPS - kept.length))
}

/** The decider's group for each tool, by tool name; a tool it can't place goes to Other. */
export const fileTools = async (
  config: GroupingConfig,
  connection: { title: string },
  groups: GroupDraft[],
  tools: LiveTool[],
) => {
  const labels = Object.fromEntries(
    groups.map((group) => [group.key, group.purpose ? `${group.title}: ${group.purpose}` : group.title]),
  )
  const placed = new Map<string, string>()
  for (let start = 0; start < tools.length; start += BATCH) {
    const batch = tools.slice(start, start + BATCH)
    const answers = await decide(
      config,
      { server: connection.title, groups: labels },
      Object.fromEntries(
        batch.map((tool, index) => [
          `t${index}`,
          {
            instructions: `Which group should this tool be in? Go by the thing it works on, not the action it takes. ${summaryOf(tool)}`,
            labels,
          },
        ]),
      ),
    )
    batch.forEach((tool, index) => {
      const choice = answers[`t${index}`]?.choice
      placed.set(tool.name, choice && choice in labels ? choice : OTHER.key)
    })
  }
  return placed
}

/** Groups under the 3-tool minimum go to Other (Other itself stays whatever its size), empty groups go. */
export const tidy = (groups: GroupDraft[], placed: Map<string, string>): Proposal => {
  const members = (key: string) => [...placed].filter(([, group]) => group === key).map(([tool]) => tool)
  const lonely = groups.filter((group) => group.key !== OTHER.key && members(group.key).length < MIN_TOOLS)
  for (const group of lonely) for (const tool of members(group.key)) placed.set(tool, OTHER.key)
  return groups
    .map((group) => ({ ...group, purpose: group.purpose ?? null, tools: members(group.key) }))
    .filter((group) => group.tools.length > 0)
}

/**
 * One more round for what the first left over: tools in groups under the minimum, and Other's. When there are enough
 * the writer names broader groups for them; the decider then files only the leftovers among the groups that hold, the
 * new ones and Other. Returns the groups to tidy, with `placed` updated.
 */
const repair = async (
  config: GroupingConfig,
  connection: { title: string },
  groups: GroupDraft[],
  placed: Map<string, string>,
  tools: LiveTool[],
) => {
  const sizeOf = (key: string) => [...placed.values()].filter((group) => group === key).length
  const named = groups.filter((group) => group.key !== OTHER.key)
  const kept = named.filter((group) => sizeOf(group.key) >= MIN_TOOLS)
  const lonely = named.some((group) => sizeOf(group.key) > 0 && sizeOf(group.key) < MIN_TOOLS)
  const leftover = tools.filter((tool) => !kept.some((group) => group.key === placed.get(tool.name)))
  const more = leftover.length >= LEFTOVER ? await nameMore(config, connection, kept, leftover) : []
  // Nothing to gain: no small group to dissolve and no new group to file into
  if (!leftover.length || (!lonely && !more.length)) return groups
  const next = [...kept, ...more, OTHER_GROUP]
  for (const [tool, group] of await fileTools(config, connection, next, leftover)) placed.set(tool, group)
  return next
}

/** A whole grouping for a connection: names, filing, one more round for the leftovers, then tidying. */
export const propose = async (
  config: GroupingConfig,
  connection: { title: string; instructions: string | null },
  tools: LiveTool[],
  log: (message: string) => void = () => {},
): Promise<Proposal> => {
  const groups = await nameGroups(config, connection, tools)
  const placed = await fileTools(config, connection, groups, tools)
  // The first round stands by itself: a second that fails leaves it as it is
  const settled = await repair(config, connection, groups, placed, tools).catch((error: unknown) => {
    log(
      `grouping: ${connection.title} kept its first round (${error instanceof Error ? error.message : String(error)})`,
    )
    return groups
  })
  return tidy(settled, placed)
}
