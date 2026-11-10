/**
 * Flags: something in a pack to recheck because its upstream changed the tool. Wording was written against one
 * version of a tool and the live description has moved on (the pack keeps its text for agents; the owner keeps or
 * rewrites it), or the live tool no longer takes an input the pack fixes (the call would fail until it is fixed).
 */
import type { ToolsRepo } from '../tools/repo.js'
import { fixedOf, lostInputs } from './entries.js'
import type { PacksRepo } from './repo.js'
import type { PackRow, PackToolRow } from './schema.js'

export type Flag = { was: string; now: string }

/** The flag on one pack tool: the description it was worded against, and the live one, when they differ. */
export const flagOf = (
  live: { versionId: string; description: string } | undefined,
  based: { id: string; description: string } | undefined,
): Flag | null =>
  live && based && based.id !== live.versionId && based.description !== live.description
    ? { was: based.description, now: live.description }
    : null

type Flagged = { kind: 'wording' | 'input'; pack: PackRow; tool: PackToolRow; flag: Flag }

/** Every flag across packs: rewritten tools first, then fixed inputs their tool dropped. */
export const packFlags = async ({ packs, tools }: { packs: PacksRepo; tools: ToolsRepo }): Promise<Flagged[]> => {
  const wording = await Promise.all(
    (await packs.reworded()).map(async ({ pack, tool }) => {
      const flag = flagOf(await tools.live(tool.toolName), tool.basedOn ? await tools.version(tool.basedOn) : undefined)
      return flag ? [{ kind: 'wording' as const, pack, tool, flag }] : []
    }),
  )
  const inputs = await Promise.all(
    (await packs.fixing()).map(async ({ pack, tool }) => {
      const live = await tools.live(tool.toolName)
      const lost = live ? lostInputs(live.inputSchema, fixedOf(tool)) : []
      return lost.length
        ? [
            {
              kind: 'input' as const,
              pack,
              tool,
              flag: { was: `fixes ${lost.join(', ')}`, now: `${tool.toolName} no longer takes ${lost.join(', ')}` },
            },
          ]
        : []
    }),
  )
  return [...wording.flat(), ...inputs.flat()]
}
