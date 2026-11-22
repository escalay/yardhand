/**
 * Flags: something in a pack to recheck because its upstream changed the tool. Wording was written against one
 * version of a tool and the live description has moved on (the pack keeps its text for agents; the owner keeps or
 * rewrites it), or a value the pack fixes or gives as a default no longer fits the live tool: the input is gone, or
 * it no longer takes the value. Until the owner changes it, a fixed value the tool refuses fails every call, a default
 * it refuses fails the calls that leave the input out, and a value for a dropped input is still sent.
 * One of the pack's own playbooks, or its skill, is flagged when a tool it was written for has left the pack under
 * that name, is no longer live, or reads differently now: agents keep the text until the owner saves it again.
 */
import type { ToolsRepo } from '../tools/repo.js'
import { defaultsOf, fixedOf, type InputProblem, inputProblems } from './entries.js'
import type { BasedOn, PackDoc, PacksRepo } from './repo.js'
import type { PackDocKind, PackRow, PackToolRow } from './schema.js'
import { type Variables, variablesFrom } from './values.js'

export type Flag = { was: string; now: string }

/** The flag on one pack tool: the description it was worded against, and the live one, when they differ. */
export const flagOf = (
  live: { versionId: string; description: string } | undefined,
  based: { id: string; description: string } | undefined,
): Flag | null =>
  live && based && based.id !== live.versionId && based.description !== live.description
    ? { was: based.description, now: live.description }
    : null

/** The flag for a tool's values that no longer fit: what the pack sets, and what is wrong with it now. */
export const inputFlagOf = (toolName: string, problems: InputProblem[]): Flag | null => {
  const errors = problems.filter((problem) => problem.level === 'error')
  const [first] = errors
  if (!first) return null
  const inputsOf = (mode: InputProblem['mode']) => [
    ...new Set(errors.filter((problem) => problem.mode === mode).map((problem) => problem.input)),
  ]
  const fixes = inputsOf('fixed')
  const defaults = inputsOf('default')
  const lost = [
    ...new Set(errors.filter((problem) => problem.code === 'unknown_input').map((problem) => problem.input)),
  ]
  return {
    was: [fixes.length ? `fixes ${fixes.join(', ')}` : '', defaults.length ? `defaults ${defaults.join(', ')}` : '']
      .filter(Boolean)
      .join(' and '),
    now: lost.length ? `${toolName} no longer takes ${lost.join(', ')}` : first.message,
  }
}

/** A document's flag: `name` is the first name it was written for that moved, `tool` the tool that name runs now. */
export type DocFlag = Flag & { name: string; tool: string | null }

/**
 * The flag on a playbook or the skill: every name it was written for (`basedOn`) that is no longer one of the
 * pack's, whose tool is not live, or whose tool's description or inputs differ from the version it was written
 * against. A version that is gone (its connection was removed and came back) counts as changed.
 */
export const docFlagOf = async (
  tools: Pick<ToolsRepo, 'live' | 'version'>,
  pack: Pick<PackRow, 'title'>,
  basedOn: BasedOn,
  entries: Pick<PackToolRow, 'name' | 'toolName'>[],
): Promise<DocFlag | null> => {
  const moved = (
    await Promise.all(
      Object.entries(basedOn).map(async ([name, versionId]) => {
        const entry = entries.find((row) => row.name === name)
        if (!entry) return [{ name, tool: null, now: `${name} is no longer in ${pack.title}` }]
        const live = await tools.live(entry.toolName)
        if (!live) return [{ name, tool: entry.toolName, now: `${entry.toolName} is not live` }]
        if (!versionId || versionId === live.versionId) return []
        const based = await tools.version(versionId)
        const now =
          based?.description !== live.description
            ? `${name} now reads: ${live.description}`
            : JSON.stringify(JSON.parse(based.inputSchema)) !== JSON.stringify(live.inputSchema)
              ? `${name}: its inputs changed`
              : null
        return now ? [{ name, tool: entry.toolName, now }] : []
      }),
    )
  ).flat()
  const [first] = moved
  return first
    ? {
        name: first.name,
        tool: first.tool,
        was: `written for ${moved.map((move) => move.name).join(', ')}`,
        now: moved.map((move) => move.now).join('; '),
      }
    : null
}

/** What a flagged document is called in a list: the playbook's name, `SKILL.md` for the skill. */
export const itemOf = (doc: Pick<PackDoc, 'kind' | 'name'>) => (doc.kind === 'skill' ? 'SKILL.md' : doc.name)

export type Flagged =
  | { kind: 'wording' | 'input'; pack: PackRow; tool: PackToolRow; flag: Flag }
  | { kind: PackDocKind; pack: PackRow; item: string; flag: DocFlag }

/**
 * Every flag across packs: rewritten tools first, then tools with a value that no longer fits, then the packs' own
 * playbooks and skills written for a tool that has changed or left.
 */
export const packFlags = async ({ packs, tools }: { packs: PacksRepo; tools: ToolsRepo }): Promise<Flagged[]> => {
  const wording = await Promise.all(
    (await packs.reworded()).map(async ({ pack, tool }) => {
      const flag = flagOf(await tools.live(tool.toolName), tool.basedOn ? await tools.version(tool.basedOn) : undefined)
      return flag ? [{ kind: 'wording' as const, pack, tool, flag }] : []
    }),
  )
  const setting = await packs.fixing()
  const variables = new Map<string, Variables>()
  for (const { pack } of setting)
    if (!variables.has(pack.id)) variables.set(pack.id, variablesFrom(await packs.variablesOf(pack.id)))
  const inputs = await Promise.all(
    setting.map(async ({ pack, tool }) => {
      const live = await tools.live(tool.toolName)
      const flag = live
        ? inputFlagOf(
            tool.toolName,
            inputProblems(live, { fixed: fixedOf(tool), defaults: defaultsOf(tool) }, variables.get(pack.id) ?? {}),
          )
        : null
      return flag ? [{ kind: 'input' as const, pack, tool, flag }] : []
    }),
  )
  const entries = new Map<string, PackToolRow[]>()
  const docs: Flagged[] = []
  for (const { pack, doc } of await packs.allDocs()) {
    if (!entries.has(pack.id)) entries.set(pack.id, (await packs.contentsOf(pack)).tools)
    const flag = await docFlagOf(tools, pack, doc.basedOn, entries.get(pack.id) ?? [])
    if (flag) docs.push({ kind: doc.kind, pack, item: itemOf(doc), flag })
  }
  return [...wording.flat(), ...inputs.flat(), ...docs]
}
