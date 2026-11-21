/**
 * The checks on a pack, one function for every way a pack is written (the app, the API, a config import), and the
 * one rule for a change: it is refused only for what it breaks itself. An error the pack already had, where the
 * change doesn't touch it, stays a flag for the owner and never blocks another change.
 */
import { ProblemError } from '../../kit/index.js'
import { inputProblems } from './entries.js'
import type { PackState } from './state.js'
import { namesIn, VARIABLE, type Variables } from './values.js'

export type Finding = {
  level: 'error' | 'warning'
  code: string
  /** Where, by the names after the change: `tools.greet_from_desk.fixed.from`, `variables.city`. */
  path: string
  /** The same by the stored names, so a rename never makes an old finding look new. Never returned. */
  key: string
  message: string
  /** For a finding in a tool: the pack's name for it, and the tool it runs. Never returned. */
  tool?: { name: string; runs: string }
}

/**
 * A finding as a sentence that stands alone: one in a tool opens with the pack's name for that tool, unless the
 * sentence already opens with it (a tool under its own name that lacks an input).
 */
export const sentenceOf = ({ tool, message }: Finding) =>
  !tool || (tool.name === tool.runs && message.startsWith(`${tool.runs} `)) ? message : `${tool.name}: ${message}`

const variablesIn = (state: PackState): Variables =>
  Object.fromEntries(state.variables.map((variable) => [variable.name, variable.value]))

/** Every value a pack sets that writes `{{name}}`, as the tool and input it sits in. */
export const writersOf = (state: PackState, name: string) =>
  state.tools.flatMap((tool) =>
    Object.entries({ ...tool.fixed, ...tool.defaults })
      .filter(([, value]) => namesIn(value).includes(name))
      .map(([input]) => ({ tool: tool.name, input })),
  )

/** Everything wrong with a pack as it stands: errors (a call would fail, or a name is no name) and warnings. */
export const checkPack = (state: PackState): Finding[] => {
  const variables = variablesIn(state)
  const seen = new Set<string>()
  const names = state.variables.flatMap(({ name }): Finding[] => {
    const at = { path: `variables.${name}`, key: `variables.${name}` }
    if (seen.has(name))
      return [{ level: 'error', code: 'duplicate_variable', ...at, message: `${name} is declared twice: keep one` }]
    seen.add(name)
    return VARIABLE.test(name)
      ? []
      : [
          {
            level: 'error',
            code: 'bad_variable_name',
            ...at,
            message: `${name} is not a variable name: start with a lowercase letter, then lowercase letters, digits or _ (40 at most), like desk_name`,
          },
        ]
  })
  const tools = state.tools.flatMap((tool): Finding[] => {
    const { live } = tool
    const of = { name: tool.name, runs: tool.tool }
    if (!live)
      return Object.keys(tool.fixed).length || Object.keys(tool.defaults).length
        ? [
            {
              level: 'warning',
              code: 'not_live',
              path: `tools.${tool.name}`,
              key: `tools.${tool.key}`,
              message: `${tool.tool} is not live, so its values are not checked: sync its upstream`,
              tool: of,
            },
          ]
        : []
    return inputProblems(live, tool, variables).map((problem) => {
      const where = `${problem.mode === 'fixed' ? 'fixed' : 'defaults'}.${problem.input}`
      return {
        level: problem.level,
        code: problem.code,
        path: `tools.${tool.name}.${where}`,
        key: `tools.${tool.key}.${where}`,
        message: problem.message,
        tool: of,
      }
    })
  })
  const unused = [...seen]
    .filter((name) => !writersOf(state, name).length)
    .map(
      (name): Finding => ({
        level: 'warning',
        code: 'unused_variable',
        path: `variables.${name}`,
        key: `variables.${name}`,
        message: `${name} is not used by any tool yet`,
      }),
    )
  return [...names, ...tools, ...unused]
}

/** Is this finding under one of the places the request itself sends? A place is a whole name, never a start of one. */
const touchedBy = (touched: string[], key: string) =>
  touched.some((place) => key === place || key.startsWith(`${place}.`))

/**
 * A change, judged: `findings` is everything wrong with the pack after it; `refused` is what the change itself
 * breaks: an error the pack didn't have before, an error under a place the request sends (`touched`, by stored
 * names), and a variable removed while a value still writes it.
 */
export const judge = (before: PackState, after: PackState, touched: string[]) => {
  const had = checkPack(before)
  const findings = checkPack(after)
  const kept = new Set(after.variables.map((variable) => variable.name))
  const stillWritten = before.variables.filter(
    (variable, index, all) =>
      !kept.has(variable.name) &&
      all.findIndex((other) => other.name === variable.name) === index &&
      writersOf(after, variable.name).length,
  )
  const inUse = stillWritten.map(
    ({ name }): Finding => ({
      level: 'error',
      code: 'variable_in_use',
      path: `variables.${name}`,
      key: `variables.${name}`,
      message: `{{${name}}} is still used by ${writersOf(after, name)
        .map((writer) => `${writer.tool} (${writer.input})`)
        .join(', ')}: change that first, or keep the variable.`,
    }),
  )
  // A value left without its variable is that removal's doing: it is said once, as the variable still in use
  const broken = stillWritten.length
    ? checkPack({ ...after, variables: [...after.variables, ...stillWritten] })
    : findings
  const refused = [
    ...broken.filter(
      (finding) =>
        finding.level === 'error' &&
        (touchedBy(touched, finding.key) ||
          !had.some((old) => old.level === 'error' && old.code === finding.code && old.key === finding.key)),
    ),
    ...inUse,
  ]
  return { refused, findings }
}

/**
 * Throws a 400 naming everything a change was refused for, each with the pack's tool it is in, and where to read the
 * inputs of the tools those run; nothing when it is fine.
 */
export const throwOnRefused = (refused: Finding[]) => {
  if (!refused.length) return
  const said = refused.map((finding) => sentenceOf(finding).replace(/\.$/, '')).join('; ')
  const [tool, ...others] = [...new Set(refused.flatMap((finding) => (finding.tool ? [finding.tool.runs] : [])))]
  const read = !tool
    ? ''
    : others.length
      ? ` GET /api/tools/{name} shows the inputs of each: ${[tool, ...others].join(', ')}.`
      : ` GET /api/tools/${tool} shows its inputs.`
  throw new ProblemError('bad_request', {
    detail: `Not saved: ${said}.${read}`,
    errors: refused.map((finding) => ({ in: 'body' as const, path: finding.path, message: finding.message })),
  })
}
