/**
 * A pack as its checks read it (`checks.ts`): its tools with the values each sets, and its variables. A change is
 * checked by building the state it would leave: `packStateOf` reads what is stored, and the `with…` functions give
 * the state after a change without writing anything.
 */
import type { LiveTool, ToolsRepo } from '../tools/repo.js'
import { defaultsOf, type Fixed, fixedOf } from './entries.js'
import type { PackContents, PacksRepo } from './repo.js'
import type { PackRow } from './schema.js'
import type { Scalar } from './values.js'

export type PackStateTool = {
  /** The name the row is stored under. */
  key: string
  /** The name after the change: it differs from `key` only in a rename. */
  name: string
  tool: string
  /** The live tool behind it, or null when it is gone or not live. */
  live: Pick<LiveTool, 'name' | 'inputSchema'> | null
  /** As stored: `{{name}}` not yet filled in. */
  fixed: Fixed
  defaults: Fixed
}
export type PackStateVariable = { name: string; value: Scalar; description: string | null }
export type PackState = { name: string; title: string; tools: PackStateTool[]; variables: PackStateVariable[] }

/** The pack as stored; `contents` when the caller has already read them. */
export const packStateOf = async (
  { packs, tools }: { packs: PacksRepo; tools: ToolsRepo },
  pack: PackRow,
  contents?: PackContents,
): Promise<PackState> => {
  const held = contents ?? (await packs.contentsOf(pack))
  const live = new Map((await tools.liveMany(held.tools.map((row) => row.toolName))).map((tool) => [tool.name, tool]))
  return {
    name: pack.name,
    title: pack.title,
    tools: held.tools.map((row) => ({
      key: row.name,
      name: row.name,
      tool: row.toolName,
      live: live.get(row.toolName) ?? null,
      fixed: fixedOf(row),
      defaults: defaultsOf(row),
    })),
    variables: held.variables.flatMap((row) =>
      row.value === null
        ? []
        : [{ name: row.name, value: JSON.parse(row.value) as Scalar, description: row.description }],
    ),
  }
}

/** After adding tools at the end and then removing by name. A name already in the pack stays as it is. */
export const withTools = (state: PackState, added: PackStateTool[], removedNames: string[]): PackState => {
  const have = new Set(state.tools.map((tool) => tool.name))
  const fresh = added.filter((tool) => !have.has(tool.name) && have.add(tool.name))
  return { ...state, tools: [...state.tools, ...fresh].filter((tool) => !removedNames.includes(tool.name)) }
}

/** After renaming the tool stored as `key`, or replacing what it fixes or defaults. */
export const withEntry = (
  state: PackState,
  key: string,
  change: { name?: string; fixed?: Fixed; defaults?: Fixed },
): PackState => ({
  ...state,
  tools: state.tools.map((tool) =>
    tool.key === key
      ? {
          ...tool,
          ...(change.name === undefined ? {} : { name: change.name }),
          ...(change.fixed === undefined ? {} : { fixed: change.fixed }),
          ...(change.defaults === undefined ? {} : { defaults: change.defaults }),
        }
      : tool,
  ),
})

/** After replacing the pack's variables. */
export const withVariables = (state: PackState, variables: PackStateVariable[]): PackState => ({ ...state, variables })
