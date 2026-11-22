/**
 * A build's proposal: the pack as it is and as drafted, told apart line by line (a tool, its wording, one input, a
 * variable, a playbook, the skill), each with what it needs from the others. The owner accepts any set of lines whose
 * needs are in it; those are applied to the pack as it is, judged by the pack's own checks, and written with the same
 * repo calls the routes use. Nothing is written before accept.
 */

import { basedOnOf, docPathOf } from '../packs/checks.js'
import { modeOf } from '../packs/entries.js'
import { toolRefsIn } from '../packs/playbook.js'
import type { PacksRepo } from '../packs/repo.js'
import type { PackRow } from '../packs/schema.js'
import { SKILL_DOC } from '../packs/skill.js'
import type { PackState, PackStateTool } from '../packs/state.js'
import { withDoc } from '../packs/state.js'
import { namesIn, placeholdersIn, type Scalar } from '../packs/values.js'
import { needsWrite } from '../tools/repo.js'

/** A pack tool as a draft has it: as the checks read it, with the pack's wording. */
export type DraftTool = PackStateTool & { wording: string | null }
/** A pack as drafted: what the checks read, and the wording of each tool. */
export type Draft = Omit<PackState, 'tools'> & { tools: DraftTool[] }

export type LineKind = 'tool' | 'wording' | 'variable' | 'input' | 'playbook' | 'skill'
type InputValue = { mode: 'fixed' | 'default' | 'agent'; value: unknown }
export type Line = {
  /** `tool:<name>`, `wording:<name>`, `input:<name>.<input>`, `variable:<name>`, `playbook:<name>`, `skill`. */
  id: string
  kind: LineKind
  /** The pack's name for the tool, the variable, the playbook; `<name>.<input>` for an input; `SKILL`. */
  target: string
  change: 'add' | 'change' | 'remove'
  before: unknown
  after: unknown
  reason: string | null
  /** A tool line for a tool that changes things: never tried in rehearsal, and not ticked to begin with. */
  changesThings: boolean
  /** Ticked to begin with: not a tool that changes things, and needing none. */
  suggested: boolean
  /** The lines it can't be accepted without. */
  needs: string[]
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const changeOf = (before: unknown, after: unknown): Line['change'] =>
  before === null ? 'add' : after === null ? 'remove' : 'change'
const inputOf = (tool: DraftTool | undefined, input: string): InputValue => {
  if (!tool) return { mode: 'agent', value: null }
  const mode = modeOf(tool, input)
  return { mode, value: mode === 'fixed' ? tool.fixed[input] : mode === 'default' ? tool.defaults[input] : null }
}

/** Every line that tells the draft from the pack as it is, in the order the proposal shows them. */
export const linesOf = (before: Draft, after: Draft, reasons: Record<string, string>): Line[] => {
  const had = new Map(before.tools.map((tool) => [tool.name, tool]))
  const has = new Map(after.tools.map((tool) => [tool.name, tool]))
  const line = (kind: LineKind, target: string, was: unknown, now: unknown, id = `${kind}:${target}`) => ({
    id,
    kind,
    target,
    change: changeOf(was, now),
    before: was,
    after: now,
    reason: reasons[id] ?? null,
    changesThings: false,
    suggested: true,
    needs: [] as string[],
  })
  const tools: Line[] = [
    ...after.tools
      .filter((tool) => !had.has(tool.name))
      .map((tool) => ({
        ...line('tool', tool.name, null, { tool: tool.tool }),
        changesThings: Boolean(
          tool.live && needsWrite({ access: tool.live.access ?? null, annotations: tool.live.annotations ?? {} }),
        ),
      })),
    ...before.tools
      .filter((tool) => !has.has(tool.name))
      .map((tool) => line('tool', tool.name, { tool: tool.tool }, null)),
  ]
  const wording = after.tools.flatMap((tool) => {
    const was = had.get(tool.name)?.wording ?? null
    return was === tool.wording ? [] : [line('wording', tool.name, was, tool.wording)]
  })
  const inputs = after.tools.flatMap((tool) => {
    const old = had.get(tool.name)
    const names = [
      ...new Set([
        ...Object.keys(old?.fixed ?? {}),
        ...Object.keys(old?.defaults ?? {}),
        ...Object.keys(tool.fixed),
        ...Object.keys(tool.defaults),
      ]),
    ]
    return names.flatMap((input) => {
      const was = inputOf(old, input)
      const now = inputOf(tool, input)
      if (same(was, now)) return []
      return [
        {
          ...line('input', `${tool.name}.${input}`, was, now),
          change: was.mode === 'agent' ? 'add' : now.mode === 'agent' ? 'remove' : 'change',
        } as Line,
      ]
    })
  })
  const variable = (draft: Draft, name: string) => {
    const found = draft.variables.find((entry) => entry.name === name)
    return found ? { value: found.value, description: found.description } : null
  }
  const variables = [...new Set([...after.variables, ...before.variables].map((entry) => entry.name))].flatMap(
    (name) => {
      const was = variable(before, name)
      const now = variable(after, name)
      return same(was, now) ? [] : [line('variable', name, was, now)]
    },
  )
  const playbook = (draft: Draft, name: string) => draft.playbooks.find((doc) => doc.name === name)?.markdown ?? null
  const playbooks = [...new Set([...after.playbooks, ...before.playbooks].map((doc) => doc.name))].flatMap((name) => {
    const was = playbook(before, name)
    const now = playbook(after, name)
    return was === now ? [] : [line('playbook', name, was, now)]
  })
  const skillWas = before.skill?.markdown ?? null
  const skillNow = after.skill?.markdown ?? null
  const skill = skillWas === skillNow ? [] : [line('skill', SKILL_DOC, skillWas, skillNow, 'skill')]
  const lines: Line[] = [...tools, ...wording, ...inputs, ...variables, ...playbooks, ...skill]

  // What each line needs: a tool being added, and the variables being added or changed that its value or text writes
  const ids = new Set(lines.map((entry) => entry.id))
  const added = (id: string) => lines.some((entry) => entry.id === id && entry.change !== 'remove')
  const toolsIn = (names: string[]) => names.map((name) => `tool:${name}`).filter((id) => ids.has(id) && added(id))
  const variablesIn = (names: string[]) =>
    names.map((name) => `variable:${name}`).filter((id) => ids.has(id) && added(id))
  for (const entry of lines) {
    if (entry.kind === 'wording') entry.needs = toolsIn([entry.target])
    if (entry.kind === 'input') {
      const name = entry.target.slice(0, entry.target.lastIndexOf('.'))
      entry.needs = [...toolsIn([name]), ...variablesIn(namesIn((entry.after as InputValue).value))]
    }
    if ((entry.kind === 'playbook' || entry.kind === 'skill') && typeof entry.after === 'string')
      entry.needs = [...toolsIn(toolRefsIn(entry.after)), ...variablesIn(placeholdersIn(entry.after))]
  }
  // A line is ticked to begin with only when everything it needs is
  const suggested = new Map(lines.map((entry) => [entry.id, !entry.changesThings]))
  for (let moved = true; moved; ) {
    moved = false
    for (const entry of lines)
      if (suggested.get(entry.id) && entry.needs.some((id) => !suggested.get(id))) {
        suggested.set(entry.id, false)
        moved = true
      }
  }
  return lines.map((entry) => ({ ...entry, suggested: suggested.get(entry.id) ?? false }))
}

/** Each chosen line whose needs are not all chosen, with the ones missing. */
export const missingNeeds = (lines: Line[], chosen: string[]) => {
  const picked = new Set(chosen)
  return lines
    .filter((line) => picked.has(line.id))
    .flatMap((line) => {
      const needs = line.needs.filter((id) => !picked.has(id))
      return needs.length ? [{ line: line.id, needs }] : []
    })
}

/** Where the checks file what these lines change: the places a save of them sends (`judge`'s `touched`). */
export const touchedOf = (lines: Line[]) =>
  lines.flatMap((line) => {
    if (line.kind === 'tool')
      return line.change === 'remove' ? [] : [`tools.${line.target}.fixed`, `tools.${line.target}.defaults`]
    if (line.kind === 'input') {
      const name = line.target.slice(0, line.target.lastIndexOf('.'))
      return [`tools.${name}.fixed`, `tools.${name}.defaults`]
    }
    if (line.kind === 'variable') return [`variables.${line.target}`]
    if (line.kind === 'playbook') return [docPathOf('playbook', line.target)]
    if (line.kind === 'skill') return ['skill']
    return []
  })

/** The pack as it is with these lines of the draft applied, and nothing else. */
export const applyLines = (before: Draft, after: Draft, lines: Line[]): Draft => {
  let state: Draft = { ...before, tools: [...before.tools], variables: [...before.variables] }
  const drafted = new Map(after.tools.map((tool) => [tool.name, tool]))
  const update = (name: string, change: (tool: DraftTool) => DraftTool) => {
    state = { ...state, tools: state.tools.map((tool) => (tool.name === name ? change(tool) : tool)) }
  }
  // Tools first, so a line on a tool being added finds it
  for (const line of lines.filter((entry) => entry.kind === 'tool')) {
    const tool = drafted.get(line.target)
    if (line.change === 'remove') state = { ...state, tools: state.tools.filter((entry) => entry.name !== line.target) }
    else if (tool && !state.tools.some((entry) => entry.name === tool.name))
      state = { ...state, tools: [...state.tools, { ...tool, fixed: {}, defaults: {}, wording: null }] }
  }
  for (const line of lines) {
    if (line.kind === 'wording') update(line.target, (tool) => ({ ...tool, wording: line.after as string | null }))
    if (line.kind === 'input') {
      const split = line.target.lastIndexOf('.')
      const [name, input] = [line.target.slice(0, split), line.target.slice(split + 1)]
      const { mode, value } = line.after as InputValue
      update(name, (tool) => {
        const fixed = { ...tool.fixed }
        const defaults = { ...tool.defaults }
        delete fixed[input]
        delete defaults[input]
        if (mode === 'fixed') fixed[input] = value
        if (mode === 'default') defaults[input] = value
        return { ...tool, fixed, defaults }
      })
    }
    if (line.kind === 'variable') {
      const now = line.after as { value: Scalar; description: string | null } | null
      const kept = state.variables.filter((entry) => entry.name !== line.target)
      const at = state.variables.findIndex((entry) => entry.name === line.target)
      const entry = now ? [{ name: line.target, ...now }] : []
      state = {
        ...state,
        variables: at < 0 ? [...kept, ...entry] : [...kept.slice(0, at), ...entry, ...kept.slice(at)],
      }
    }
    if (line.kind === 'playbook' || line.kind === 'skill')
      state = { ...state, ...withDoc(state, line.kind, line.target, line.after as string | null), tools: state.tools }
  }
  return state
}

/**
 * Writes the difference between the pack as it is and as accepted, with the routes' own repo calls. New and changed
 * variables first and removed ones last, so a value written meanwhile never finds its variable missing.
 */
export const write = async ({ packs }: { packs: PacksRepo }, pack: PackRow, before: Draft, after: Draft) => {
  const stored = new Map(before.tools.map((tool) => [tool.name, tool]))
  const kept = new Set(after.tools.map((tool) => tool.name))
  const variables = (draft: Draft) =>
    draft.variables.map((entry) => ({ name: entry.name, value: entry.value, description: entry.description }))
  const union = [
    ...variables(after),
    ...variables(before).filter((entry) => !after.variables.some((other) => other.name === entry.name)),
  ]
  if (!same(variables(before), union)) await packs.setVariables(pack.id, union)
  const fresh = after.tools.filter((tool) => !stored.has(tool.name))
  if (fresh.length)
    await packs.addTools(
      pack.id,
      fresh.map((tool) => ({
        name: tool.tool,
        // An AI build has no reason of its own: the owner picked each line it accepted
        reason: 'picked' as const,
        alias: tool.name === tool.tool ? null : tool.name,
        fixed: tool.fixed,
        defaults: tool.defaults,
      })),
    )
  const gone = before.tools.filter((tool) => !kept.has(tool.name)).map((tool) => tool.name)
  if (gone.length) await packs.removeTools(pack.id, gone)
  for (const tool of after.tools) {
    const was = stored.get(tool.name)
    if (was && (!same(was.fixed, tool.fixed) || !same(was.defaults, tool.defaults)))
      await packs.setEntry(pack.id, tool.name, { fixed: tool.fixed, defaults: tool.defaults })
    if ((was?.wording ?? null) !== tool.wording)
      await packs.setWording(pack.id, tool.name, tool.wording, tool.live?.versionId ?? null)
  }
  for (const doc of after.playbooks)
    if (before.playbooks.find((other) => other.name === doc.name)?.markdown !== doc.markdown)
      await packs.saveDoc(pack.id, 'playbook', doc.name, {
        body: doc.markdown,
        basedOn: basedOnOf(after, docPathOf('playbook', doc.name)),
        source: 'ai',
      })
  for (const doc of before.playbooks)
    if (!after.playbooks.some((other) => other.name === doc.name)) await packs.removeDoc(pack.id, 'playbook', doc.name)
  if (after.skill && after.skill.markdown !== before.skill?.markdown)
    await packs.saveDoc(pack.id, 'skill', SKILL_DOC, {
      body: after.skill.markdown,
      basedOn: basedOnOf(after, 'skill'),
      source: 'ai',
    })
  if (!after.skill && before.skill) await packs.removeDoc(pack.id, 'skill', SKILL_DOC)
  if (!same(union, variables(after))) await packs.setVariables(pack.id, variables(after))
}
