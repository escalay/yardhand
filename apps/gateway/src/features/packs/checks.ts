/**
 * The checks on a pack, one function for every way a pack is written (the app, the API, a config import), and the
 * one rule for a change: it is refused only for what it breaks itself. An error the pack already had, where the
 * change doesn't touch it, stays a flag for the owner and never blocks another change. A playbook or the skill is
 * refused only when it is the text being saved: a tool renamed or removed under it goes through and leaves it flagged.
 */
import { ProblemError } from '../../kit/index.js'
import { OWN_NAMES } from '../../mcp/tools.js'
import { needsWrite } from '../tools/repo.js'
import { inputProblems } from './entries.js'
import { withoutFrontMatter } from './frontmatter.js'
import { MAX_STEPS, PLAYBOOK_NAME, parsePlaybook, stepsIn, toolRefsIn } from './playbook.js'
import type { BasedOn } from './repo.js'
import type { PackDocKind } from './schema.js'
import { packSkillPathOf, packSkillUriOf, SKILL_SECTIONS, sectionsOf } from './skill.js'
import type { PackState, PackStateDoc } from './state.js'
import { namesIn, placeholdersIn, VARIABLE, type Variables } from './values.js'

export type Finding = {
  level: 'error' | 'warning'
  code: string
  /**
   * Where, by the names after the change: `tools.greet_from_desk.fixed.from`, `variables.city`,
   * `playbooks.say-hello`, `skill`.
   */
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

/** Where a document's findings are filed: `playbooks.<name>` for one of the pack's own playbooks, `skill`. */
export const docPathOf = (kind: PackDocKind, name: string) => (kind === 'skill' ? 'skill' : `playbooks.${name}`)

/** The most characters one playbook or the skill holds. */
export const DOC_MAX = 60_000

/** The pack's documents that write `{{name}}` in their text, as a sentence names them. */
export const docWritersOf = (state: PackState, name: string) => [
  ...state.playbooks
    .filter((doc) => placeholdersIn(withoutFrontMatter(doc.markdown)).includes(name))
    .map((doc) => `the playbook ${doc.name}`),
  ...(state.skill && placeholdersIn(state.skill.markdown).includes(name) ? ['the skill'] : []),
]

const FILE = /\.(md|mdx|json|jsonl|txt|ya?ml|csv|tsv|html?|xml|pdf|png|jpe?g|gif|svg|js|ts|py|sh|sql|toml|zip)$/i
/** Could this be a tool's name? Letters, digits, `_`, `-` and `.`, with a `_` or a `.`, and not a file's name. */
const toolShaped = (word: string) =>
  /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(word) && /[_.]/.test(word) && /[A-Za-z]/.test(word) && !FILE.test(word)

type DocRead = { findings: Finding[]; uses: string[] }

/**
 * What a text gets wrong, and the pack's tools it names. A `{{word}}` must be one of its arguments or a variable of
 * the pack: in a text nothing is sent as written. A name in backticks is read as a tool when it is one of the pack's,
 * one of a connection's, one the stored text was written for, or shaped like one.
 */
const readText = (
  state: PackState,
  variables: Variables,
  path: string,
  doc: PackStateDoc,
  body: string,
  given: string[],
): DocRead => {
  const at = { path, key: path }
  const unresolved = placeholdersIn(body)
    .filter((word) => !given.includes(word) && !Object.hasOwn(variables, word))
    .map(
      (word): Finding => ({
        level: 'error',
        code: 'unresolved',
        ...at,
        message:
          path === 'skill'
            ? `{{${word}}} is no variable of ${state.title}: declare it, or take it out.`
            : `{{${word}}} is neither an argument of this playbook nor a variable of ${state.title}: declare one, or take it out.`,
      }),
    )
  const known = new Set([
    ...OWN_NAMES,
    ...given,
    ...Object.keys(variables),
    ...state.playbooks.map((playbook) => playbook.name),
    ...state.heldPlaybooks,
    ...state.tools.flatMap((tool) => Object.keys((tool.live?.inputSchema.properties ?? {}) as object)),
  ])
  const uses: string[] = []
  const named = toolRefsIn(body).flatMap((word): Finding[] => {
    const tool = state.tools.find((entry) => entry.name === word)
    if (tool) {
      uses.push(word)
      return tool.live?.annotations &&
        needsWrite({ access: tool.live.access ?? null, annotations: tool.live.annotations })
        ? [
            {
              level: 'warning',
              code: 'needs_write',
              ...at,
              message: `\`${word}\` changes things: a read-only key can’t run it.`,
            },
          ]
        : []
    }
    const aliases = state.tools.filter((entry) => entry.tool === word).map((entry) => `\`${entry.name}\``)
    if (aliases.length)
      return [
        {
          level: 'error',
          code: 'use_alias',
          ...at,
          message: `\`${word}\` is called ${aliases.join(' and ')} in ${state.title}: write ${aliases.length === 1 ? 'that' : 'the one you mean'}.`,
        },
      ]
    if (!toolShaped(word)) return []
    if (state.upstreams.includes(word.slice(0, Math.max(0, word.indexOf('.')))))
      return [
        {
          level: 'error',
          code: 'not_in_pack',
          ...at,
          message: `\`${word}\` is not in ${state.title}: add it to the pack, or take it out of the text.`,
        },
      ]
    if (doc.wrote.includes(word))
      return [
        {
          level: 'error',
          code: 'left_pack',
          ...at,
          message: `\`${word}\` is no longer a tool of ${state.title}: write the name it has now, or take it out of the text.`,
        },
      ]
    return known.has(word)
      ? []
      : [
          {
            level: 'warning',
            code: 'unknown_name',
            ...at,
            message: `\`${word}\` is not a tool of ${state.title}. If it is meant as one, check the name.`,
          },
        ]
  })
  return { findings: [...unresolved, ...named], uses }
}

const tooBig = (path: string, markdown: string): Finding[] =>
  markdown.length > DOC_MAX
    ? [
        {
          level: 'error',
          code: 'too_big',
          path,
          key: path,
          message: `${markdown.length.toLocaleString('en-US')} characters: ${DOC_MAX.toLocaleString('en-US')} at most. Split it.`,
        },
      ]
    : []

const readPlaybook = (state: PackState, variables: Variables, doc: PackState['playbooks'][number]): DocRead => {
  const path = docPathOf('playbook', doc.name)
  const error = (code: string, message: string): Finding => ({ level: 'error', code, path, key: path, message })
  const name = [
    ...(PLAYBOOK_NAME.test(doc.name)
      ? []
      : [
          error(
            'bad_name',
            `${doc.name} is not a playbook name: start with a lowercase letter, then lowercase letters, digits or - (3 to 64), like find-roles`,
          ),
        ]),
    ...(state.heldPlaybooks.includes(doc.name)
      ? [
          error(
            'name_clash',
            `${state.title} already holds a playbook called ${doc.name}, from a connection: give this one another name.`,
          ),
        ]
      : []),
  ]
  const big = tooBig(path, doc.markdown)
  if (big.length) return { findings: [...name, ...big], uses: [] }
  const read = parsePlaybook(doc.name, doc.markdown)
  if ('problems' in read)
    return { findings: [...name, ...read.problems.map((problem) => error('bad_front_matter', problem))], uses: [] }
  if (!read.playbook.body.trim())
    return {
      findings: [...name, error('empty', 'the playbook has no text under its front matter: write its steps.')],
      uses: [],
    }
  const given = read.playbook.arguments.map((argument) => argument.name)
  const clashes = given
    .filter((argument) => Object.hasOwn(variables, argument))
    .map((argument) =>
      error(
        'name_clash',
        `the argument ${argument} is also a variable of ${state.title}: rename one, so {{${argument}}} means one thing.`,
      ),
    )
  const text = readText(state, variables, path, doc, read.playbook.body, given)
  const steps = stepsIn(read.playbook.body)
  return {
    findings: [
      ...name,
      ...clashes,
      ...text.findings,
      ...(steps > MAX_STEPS
        ? [
            {
              level: 'warning' as const,
              code: 'split',
              path,
              key: path,
              message: `${steps} steps: split it into playbooks of about ${MAX_STEPS} steps.`,
            },
          ]
        : []),
    ],
    uses: text.uses,
  }
}

const readSkill = (state: PackState, variables: Variables, doc: PackStateDoc): DocRead => {
  const path = 'skill'
  const big = tooBig(path, doc.markdown)
  if (big.length) return { findings: big, uses: [] }
  if (!doc.markdown.trim())
    return {
      findings: [
        {
          level: 'error',
          code: 'empty',
          path,
          key: path,
          message:
            'nothing is left of the skill once its front matter and first heading are taken off, which the gateway writes itself. Send the text under them.',
        },
      ],
      uses: [],
    }
  const text = readText(state, variables, path, doc, doc.markdown, [])
  const have = sectionsOf(doc.markdown)
  const missing = SKILL_SECTIONS.filter((section) => !have.includes(section)).map((section) =>
    section.replace("'", '’'),
  )
  const warning = (code: string, message: string): Finding => ({ level: 'warning', code, path, key: path, message })
  return {
    findings: [
      ...text.findings,
      ...(missing.length
        ? [warning('missing_section', `no section ${missing.join(', ')}: add each as a \`## \` heading.`)]
        : []),
      ...(state.manualPaths.includes(packSkillPathOf(state.name))
        ? [
            warning(
              'skill_path',
              `a manual in ${state.title} is at ${packSkillUriOf(state.name)} too: the pack’s skill is served there, and the manual at its gateway:// address.`,
            ),
          ]
        : []),
    ],
    uses: text.uses,
  }
}

/** Each of the pack's documents, read once: by `playbooks.<name>` and `skill`. */
const readDocs = (state: PackState, variables: Variables): Record<string, DocRead> => ({
  ...Object.fromEntries(
    state.playbooks.map((doc) => [docPathOf('playbook', doc.name), readPlaybook(state, variables, doc)]),
  ),
  ...(state.skill ? { skill: readSkill(state, variables, state.skill) } : {}),
})

/**
 * The pack's tools each of its documents names, by the pack's names, keyed `playbooks.<name>` and `skill`: what a
 * save notes the text as written against. Read by the same pass as `checkPack`.
 */
export const usesOf = (state: PackState): Record<string, string[]> =>
  Object.fromEntries(Object.entries(readDocs(state, variablesIn(state))).map(([path, read]) => [path, read.uses]))

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
    .filter((name) => !writersOf(state, name).length && !docWritersOf(state, name).length)
    .map(
      (name): Finding => ({
        level: 'warning',
        code: 'unused_variable',
        path: `variables.${name}`,
        key: `variables.${name}`,
        message: `${name} is not used by any tool yet`,
      }),
    )
  const docs = Object.values(readDocs(state, variables)).flatMap((read) => read.findings)
  return [...names, ...tools, ...unused, ...docs]
}

/**
 * The tool versions a document stands on once saved: every tool of the pack it names, by the pack's name, with the
 * version live now (null for one that is not live).
 */
export const basedOnOf = (state: PackState, path: string): BasedOn =>
  Object.fromEntries(
    (usesOf(state)[path] ?? []).map((name) => [
      name,
      state.tools.find((tool) => tool.name === name)?.live?.versionId ?? null,
    ]),
  )

/** Is this finding in one of the pack's documents? Those are refused only when the document itself is saved. */
const inDocument = (key: string) => key === 'skill' || key.startsWith('playbooks.')

/** Is this finding under one of the places the request itself sends? A place is a whole name, never a start of one. */
const touchedBy = (touched: string[], key: string) =>
  touched.some((place) => key === place || key.startsWith(`${place}.`))

/**
 * A change, judged: `findings` is everything wrong with the pack after it; `refused` is what the change itself
 * breaks: an error the pack didn't have before, an error under a place the request sends (`touched`, by stored
 * names), and a variable removed while a value or a text still writes it. An error in a playbook or the skill is
 * refused only when that document is touched: a change elsewhere that breaks it leaves it flagged.
 */
export const judge = (before: PackState, after: PackState, touched: string[]) => {
  const had = checkPack(before)
  const findings = checkPack(after)
  const kept = new Set(after.variables.map((variable) => variable.name))
  const stillWritten = before.variables.filter(
    (variable, index, all) =>
      !kept.has(variable.name) &&
      all.findIndex((other) => other.name === variable.name) === index &&
      writersOf(after, variable.name).length + docWritersOf(after, variable.name).length,
  )
  const inUse = stillWritten.map(
    ({ name }): Finding => ({
      level: 'error',
      code: 'variable_in_use',
      path: `variables.${name}`,
      key: `variables.${name}`,
      message: `{{${name}}} is still used by ${[
        ...writersOf(after, name).map((writer) => `${writer.tool} (${writer.input})`),
        ...docWritersOf(after, name),
      ].join(', ')}: change that first, or keep the variable.`,
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
          (!inDocument(finding.key) &&
            !had.some((old) => old.level === 'error' && old.code === finding.code && old.key === finding.key))),
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
