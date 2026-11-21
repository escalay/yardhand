/**
 * Flags: something in a pack to recheck because its upstream changed the tool. Wording was written against one
 * version of a tool and the live description has moved on (the pack keeps its text for agents; the owner keeps or
 * rewrites it), or a value the pack fixes or gives as a default no longer fits the live tool: the input is gone, or
 * it no longer takes the value. Until the owner changes it, a fixed value the tool refuses fails every call, a default
 * it refuses fails the calls that leave the input out, and a value for a dropped input is still sent.
 */
import type { ToolsRepo } from '../tools/repo.js'
import { defaultsOf, fixedOf, type InputProblem, inputProblems } from './entries.js'
import type { PacksRepo } from './repo.js'
import type { PackRow, PackToolRow } from './schema.js'
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

type Flagged = { kind: 'wording' | 'input'; pack: PackRow; tool: PackToolRow; flag: Flag }

/** Every flag across packs: rewritten tools first, then tools with a value that no longer fits. */
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
  return [...wording.flat(), ...inputs.flat()]
}
