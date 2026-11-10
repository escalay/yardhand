/**
 * Tool groups by rules, for when no model is set up (and for filing a new tool next to its kind): a Composio tool by
 * its app, a tool that publishes its route by the route's first segment (`GET /api/v1/menus/{id}` → Boards), any
 * other by the noun in its name once its verb is dropped (`listDatasets`, `get_dataset_run` → Datasets). Groups of one
 * go to Other.
 */

export type GroupDraft = { key: string; title: string; purpose?: string | null }
export type Effect = 'reads' | 'changes' | 'deletes'

export const OTHER: GroupDraft = { key: 'other', title: 'Other' }

const VERBS = new Set(
  'get list search find create update delete remove add save set read fetch filter similar check draft audit review run call make put patch post upsert batch query describe show open close start stop send move copy rename toggle enable disable generate compare explore identify count export import sync attach detach new edit write'.split(
    ' ',
  ),
)

/** `listDatasetRuns` / `get_dataset_run` → ['list', 'dataset', 'runs']. */
const wordsOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

/** A word as a group's key: `datasets` → `dataset`. */
const singular = (word: string) =>
  word.endsWith('ies') && word.length > 4
    ? `${word.slice(0, -3)}y`
    : word.endsWith('s') && !word.endsWith('ss') && word.length > 3
      ? word.slice(0, -1)
      : word

/** `dataset` → `Datasets`, `category` → `Categories`. */
const plural = (word: string) => {
  const title = `${word.charAt(0).toUpperCase()}${word.slice(1)}`
  return /[^aeiou]y$/.test(word) ? `${title.slice(0, -1)}ies` : word.endsWith('s') ? title : `${title}s`
}

export const keyOf = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'group'

/** The group rules give a tool. */
export const ruleGroupOf = (tool: { remoteName: string; route?: string | null }, apps: string[] = []): GroupDraft => {
  const app = apps.find((name) => tool.remoteName.startsWith(`${name}_`))
  if (app) return { key: app, title: app }
  const path = tool.route?.split(/\s+/)[1]
  if (path) {
    const segment = path
      .split('/')
      .filter(
        (part) => part && part !== 'api' && !/^v\d+$/.test(part) && !part.startsWith('{') && !part.startsWith(':'),
      )[0]
    const noun = segment ? wordsOf(segment).find((word) => !VERBS.has(word) && word.length > 2) : undefined
    if (noun) {
      const word = singular(noun)
      return { key: keyOf(word), title: plural(word) }
    }
  }
  const words = wordsOf(tool.remoteName)
  const noun = words.find((word) => !VERBS.has(word) && word.length > 2)
  if (!noun) return OTHER
  const word = singular(noun)
  return { key: keyOf(word), title: plural(word) }
}

/** Names that plainly build or update, however a server hints them: `createScore`, `upsert_dataset`. */
const BUILDS = /^(create|add|update|upsert|insert|set|save|attach)(?![a-z])/

/**
 * What a tool does, from its hints: reads (read-only), deletes (destructive), or changes. Servers that mark every
 * write destructive would make each create a delete, so a destructive tool whose name plainly builds or updates
 * counts as a change; one whose route is a DELETE always deletes.
 */
export const effectOf = (tool: {
  annotations: Record<string, unknown>
  remoteName?: string
  route?: string | null
}): Effect => {
  const { readOnlyHint, destructiveHint } = tool.annotations
  if (readOnlyHint === true && destructiveHint !== true) return 'reads'
  if (destructiveHint !== true) return 'changes'
  if (/^delete\s/i.test(tool.route ?? '')) return 'deletes'
  const name = tool.remoteName ?? ''
  return BUILDS.test(name.charAt(0).toLowerCase() + name.slice(1)) ? 'changes' : 'deletes'
}

/** What a tool does once the owner's own setting is counted: one set to read reads, one set to write changes. */
export const actsAs = (tool: Parameters<typeof effectOf>[0] & { ownAccess?: string | null }): Effect => {
  const effect = effectOf(tool)
  if (tool.ownAccess === 'read') return 'reads'
  return tool.ownAccess === 'write' && effect === 'reads' ? 'changes' : effect
}

/** A first grouping by rules: groups of one go to Other, except a Composio app, which is always its own group. */
export const groupByRules = (
  tools: { name: string; remoteName: string; route?: string | null }[],
  apps: string[] = [],
) => {
  const found = tools.map((tool) => ({ tool: tool.name, group: ruleGroupOf(tool, apps) }))
  const sizes = new Map<string, number>()
  for (const { group } of found) sizes.set(group.key, (sizes.get(group.key) ?? 0) + 1)
  const assignments = found.map(({ tool, group }) => ({
    tool,
    group: (sizes.get(group.key) ?? 0) < 2 && !apps.includes(group.key) ? OTHER : group,
  }))
  const groups = [...new Map(assignments.map(({ group }) => [group.key, group])).values()].sort((a, b) =>
    a.key === OTHER.key ? 1 : b.key === OTHER.key ? -1 : a.title.localeCompare(b.title),
  )
  return { groups, assignments: assignments.map(({ tool, group }) => ({ tool, group: group.key })) }
}
