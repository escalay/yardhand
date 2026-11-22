/**
 * A pack as its checks read it (`checks.ts`): its tools with the values each sets, its variables, and the playbooks
 * and skill written for it. A change is checked by building the state it would leave: `packStateOf` reads what is
 * stored, and the `with…` functions give the state after a change without writing anything.
 */

import { type ManualContent, skillPathOf } from '../catalog/content.js'
import type { CatalogRepo } from '../catalog/repo.js'
import type { LiveTool, ToolsRepo } from '../tools/repo.js'
import type { UpstreamsRepo } from '../upstreams/repo.js'
import { defaultsOf, type Fixed, fixedOf, personOf } from './entries.js'
import type { PackContents, PacksRepo } from './repo.js'
import type { PackDocKind, PackRow } from './schema.js'
import type { Scalar } from './values.js'

export type PackStateTool = {
  /** The name the row is stored under. */
  key: string
  /** The name after the change: it differs from `key` only in a rename. */
  name: string
  tool: string
  /** The live tool behind it, or null when it is gone or not live. */
  live:
    | (Pick<LiveTool, 'name' | 'inputSchema'> & Partial<Pick<LiveTool, 'versionId' | 'access' | 'annotations'>>)
    | null
  /** As stored: `{{name}}` not yet filled in. */
  fixed: Fixed
  defaults: Fixed
  /** The inputs filled per person, each `{{variable}}`. */
  person: Fixed
}
/** A variable; `value` is null when the pack has none of its own and only Per person inputs read it. */
export type PackStateVariable = { name: string; value: Scalar | null; description: string | null }
/** A playbook or the skill as written, and the names its stored text was written for (none for a new one). */
export type PackStateDoc = { markdown: string; wrote: string[] }
export type PackState = {
  name: string
  title: string
  tools: PackStateTool[]
  variables: PackStateVariable[]
  /** The pack's own playbooks, as written. */
  playbooks: (PackStateDoc & { name: string })[]
  skill: PackStateDoc | null
  /** The playbooks it holds from its connections, by name. */
  heldPlaybooks: string[]
  /** Where the manuals it holds sit as skills (`skillPathOf`). */
  manualPaths: string[]
  /** Every connection's id: a name that starts with one and a dot is a tool's. */
  upstreams: string[]
}

export type StateRepos = {
  packs: PacksRepo
  tools: ToolsRepo
  catalog: Pick<CatalogRepo, 'live'>
  upstreams: Pick<UpstreamsRepo, 'list'>
}

/** The pack as stored; `contents` when the caller has already read them. */
export const packStateOf = async (
  { packs, tools, catalog, upstreams }: StateRepos,
  pack: PackRow,
  contents?: PackContents,
): Promise<PackState> => {
  const held = contents ?? (await packs.contentsOf(pack))
  const live = new Map((await tools.liveMany(held.tools.map((row) => row.toolName))).map((tool) => [tool.name, tool]))
  const manuals = await Promise.all(held.manuals.map((name) => catalog.live('manual', name)))
  const skill = held.docs.find((doc) => doc.kind === 'skill')
  const stateDoc = (doc: PackContents['docs'][number]) => ({ markdown: doc.body, wrote: Object.keys(doc.basedOn) })
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
      person: personOf(row),
    })),
    variables: held.variables.map((row) => ({
      name: row.name,
      value: row.value === null ? null : (JSON.parse(row.value) as Scalar),
      description: row.description,
    })),
    playbooks: held.docs.filter((doc) => doc.kind === 'playbook').map((doc) => ({ name: doc.name, ...stateDoc(doc) })),
    skill: skill ? stateDoc(skill) : null,
    heldPlaybooks: held.playbooks,
    manualPaths: manuals.flatMap((item) => (item ? [skillPathOf(item.upstreamId, item.content as ManualContent)] : [])),
    upstreams: (await upstreams.list()).map((row) => row.id),
  }
}

/** After adding tools at the end and then removing by name. A name already in the pack stays as it is. */
export const withTools = (state: PackState, added: PackStateTool[], removedNames: string[]): PackState => {
  const have = new Set(state.tools.map((tool) => tool.name))
  const fresh = added.filter((tool) => !have.has(tool.name) && have.add(tool.name))
  return { ...state, tools: [...state.tools, ...fresh].filter((tool) => !removedNames.includes(tool.name)) }
}

/** After renaming the tool stored as `key`, or replacing what it fixes, defaults or fills per person. */
export const withEntry = (
  state: PackState,
  key: string,
  change: { name?: string; fixed?: Fixed; defaults?: Fixed; person?: Fixed },
): PackState => ({
  ...state,
  tools: state.tools.map((tool) =>
    tool.key === key
      ? {
          ...tool,
          ...(change.name === undefined ? {} : { name: change.name }),
          ...(change.fixed === undefined ? {} : { fixed: change.fixed }),
          ...(change.defaults === undefined ? {} : { defaults: change.defaults }),
          ...(change.person === undefined ? {} : { person: change.person }),
        }
      : tool,
  ),
})

/** After replacing the pack's variables. */
export const withVariables = (state: PackState, variables: PackStateVariable[]): PackState => ({ ...state, variables })

/**
 * After saving one of the pack's own playbooks (by name) or its skill, or removing it (`null`). A text saved again
 * keeps the names its stored text was written for, so a name that has left the pack is still known as one.
 */
export const withDoc = (state: PackState, kind: PackDocKind, name: string, markdown: string | null): PackState => {
  if (kind === 'skill')
    return { ...state, skill: markdown === null ? null : { markdown, wrote: state.skill?.wrote ?? [] } }
  const had = state.playbooks.find((doc) => doc.name === name)
  if (markdown === null) return { ...state, playbooks: state.playbooks.filter((doc) => doc !== had) }
  const doc = { name, markdown, wrote: had?.wrote ?? [] }
  return {
    ...state,
    playbooks: had ? state.playbooks.map((other) => (other === had ? doc : other)) : [...state.playbooks, doc],
  }
}

/** After adding playbooks or manuals the pack holds from its connections: playbooks by name, manuals by skill path. */
export const withHeld = (state: PackState, added: { playbooks?: string[]; manualPaths?: string[] }): PackState => ({
  ...state,
  heldPlaybooks: [...new Set([...state.heldPlaybooks, ...(added.playbooks ?? [])])],
  manualPaths: [...new Set([...state.manualPaths, ...(added.manualPaths ?? [])])],
})
