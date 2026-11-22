/**
 * A pack tool as its keys see it. The pack may call it by its own name (an alias, so one tool can sit in a pack more
 * than once, say once per account) and sets some of its inputs. A fixed input is filled on every call and taken off
 * the schema its keys read, so an agent can neither see nor change it. A default is shown with the pack's value and
 * filled when the agent sends nothing. Either value may write the pack's variables as `{{name}}`. A Per person input
 * is hidden like a fixed one and reads one variable: the caller's own value of it, else the pack's, else nothing is
 * sent and the tool's own default applies.
 */
import { Ajv } from '@modelcontextprotocol/client/validators/ajv'
import { resolveValue, type Variables, wholeNameOf } from './values.js'

/** An alias: lowercase words joined by `_` or `-`. It has no dot, so it never clashes with an `<upstream>.<tool>`. */
export const ALIAS = /^[a-z][a-z0-9_-]{1,63}$/

/** Values by input name: what a pack fixes, or what it gives as defaults. */
export type Fixed = Record<string, unknown>

/**
 * One name in a pack: the tool it runs, the pack's wording, and what it fixes and defaults, variables filled in. A
 * Per person input with a value is in `fixed`; `person` names the variable each one reads, and `unset` those that
 * have no value for this caller, hidden and not sent.
 */
export type PackEntry = {
  tool: string
  wording: string | null
  fixed: Fixed
  defaults: Fixed
  person: Record<string, string>
  unset: string[]
}

export const fixedOf = (row: { fixed: string | null }): Fixed => (row.fixed ? (JSON.parse(row.fixed) as Fixed) : {})
export const defaultsOf = (row: { defaults: string | null }): Fixed =>
  row.defaults ? (JSON.parse(row.defaults) as Fixed) : {}
/** The inputs filled per person, each as stored: `{{variable}}`. */
export const personOf = (row: { person?: string | null }): Fixed =>
  row.person ? (JSON.parse(row.person) as Fixed) : {}

/** The inputs of a `person` map that read this variable. */
export const readersOf = (person: Fixed, name: string) =>
  Object.entries(person).flatMap(([input, value]) => (wholeNameOf(value) === name ? [input] : []))

const filled = (values: Fixed, variables: Variables): Fixed =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, resolveValue(value, variables).value]))

/**
 * A stored pack tool as an entry, with the pack's variables filled into its values. `personal` is the caller's own
 * values: only a Per person input reads them, never a fixed or default value that writes the same variable.
 */
export const resolveEntry = (
  row: {
    toolName: string
    description: string | null
    fixed: string | null
    defaults: string | null
    person?: string | null
  },
  variables: Variables,
  personal: Variables = {},
): PackEntry => {
  const fixed = filled(fixedOf(row), variables)
  const person: Record<string, string> = {}
  const unset: string[] = []
  for (const [input, value] of Object.entries(personOf(row))) {
    const name = wholeNameOf(value)
    if (!name) continue
    person[input] = name
    if (Object.hasOwn(personal, name)) fixed[input] = personal[name]
    else if (Object.hasOwn(variables, name)) fixed[input] = variables[name]
    else unset.push(input)
  }
  return {
    tool: row.toolName,
    wording: row.description,
    fixed,
    defaults: filled(defaultsOf(row), variables),
    person,
    unset,
  }
}

const propertiesOf = (schema: Record<string, unknown>) =>
  (schema.properties ?? {}) as Record<string, Record<string, unknown>>

/**
 * The input schema as a pack's keys read it: without the fixed inputs and those filled per person, which are neither
 * shown nor required, and with each default as the input's `default`, no longer required.
 */
export const shownSchema = (
  schema: Record<string, unknown>,
  entry: Pick<PackEntry, 'fixed' | 'defaults'> & Partial<Pick<PackEntry, 'unset'>>,
): Record<string, unknown> => {
  const hidden = [...Object.keys(entry.fixed), ...(entry.unset ?? [])]
  const optional = [...hidden, ...Object.keys(entry.defaults)]
  if (!optional.length) return schema
  const properties = Object.fromEntries(
    Object.entries(propertiesOf(schema))
      .filter(([key]) => !hidden.includes(key))
      .map(([key, property]) => [
        key,
        Object.hasOwn(entry.defaults, key) ? { ...property, default: entry.defaults[key] } : property,
      ]),
  )
  const required = Array.isArray(schema.required)
    ? (schema.required as string[]).filter((key) => !optional.includes(key))
    : undefined
  return { ...schema, properties, ...(required ? { required } : {}) }
}

/** The tool as one entry of a pack shows it: the entry's name and wording, and its inputs as the pack sets them. */
export const presented = <T extends { name: string; description: string; inputSchema: Record<string, unknown> }>(
  tool: T,
  name: string,
  entry: Pick<PackEntry, 'wording' | 'fixed' | 'defaults'> & Partial<Pick<PackEntry, 'unset'>>,
): T => ({
  ...tool,
  name,
  description: entry.wording ?? tool.description,
  inputSchema: shownSchema(tool.inputSchema, entry),
})

/** The values whose input the tool's schema no longer has: the upstream dropped or renamed it. */
export const lostInputs = (schema: Record<string, unknown>, values: Fixed) => {
  const properties = propertiesOf(schema)
  return Object.keys(values).filter((key) => !Object.hasOwn(properties, key))
}

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false })
type Check = ((value: unknown) => boolean) & { errors?: { message?: string }[] | null }
const checks = new Map<string, Check | null>()

/** One input's schema with the definitions the tool keeps beside its inputs, so a `$ref` to one of them resolves. */
const inputSchemaOf = (tool: Record<string, unknown>, property: Record<string, unknown>) => ({
  ...property,
  ...(tool.$defs === undefined ? {} : { $defs: tool.$defs }),
  ...(tool.definitions === undefined ? {} : { definitions: tool.definitions }),
})

/** A validator per input schema, compiled once; null for one ajv can't compile, which is said and never passed. */
const checkOf = (schema: Record<string, unknown>) => {
  const key = JSON.stringify(schema)
  if (!checks.has(key)) {
    try {
      checks.set(key, ajv.compile(schema) as Check)
    } catch {
      checks.set(key, null)
    }
  }
  return checks.get(key) ?? null
}

/**
 * Why the tool's schema refuses this value for one input, or null when it takes it, has no such input, or the input's
 * schema can't be read here.
 */
export const valueProblem = (
  tool: { inputSchema: Record<string, unknown> },
  input: string,
  value: unknown,
): string | null => {
  const properties = propertiesOf(tool.inputSchema)
  const schema = Object.hasOwn(properties, input) ? properties[input] : undefined
  const check = schema ? checkOf(inputSchemaOf(tool.inputSchema, schema)) : null
  return !check || check(value) ? null : `${input} ${check.errors?.[0]?.message ?? 'is invalid'}`
}

/** The kinds of value a variable can hold, as the app asks for one. */
export type ValueKind = 'text' | 'number' | 'boolean'
const KINDS: Record<string, ValueKind> = { string: 'text', number: 'number', integer: 'number', boolean: 'boolean' }
const typeOfValue = (value: unknown) => (value === null ? 'null' : typeof value)

/** The types one schema says: its `type`, else the type of its choices; empty when it says none. */
const typesOf = (schema: Record<string, unknown>): unknown[] => {
  if (schema.type !== undefined) return [schema.type].flat()
  return [
    ...(Array.isArray(schema.enum) ? schema.enum : []),
    ...(Object.hasOwn(schema, 'const') ? [schema.const] : []),
  ].map(typeOfValue)
}

/** The types of the branches an input may take (`anyOf`, `oneOf`); unknown when a branch says none. */
const branchTypesOf = (schema: Record<string, unknown>): unknown[] => {
  const branches = [schema.anyOf, schema.oneOf].find(Array.isArray) ?? []
  const types = branches.map((branch) => (branch && typeof branch === 'object' ? typesOf(branch) : []))
  return types.some((branch) => branch.length === 0) ? ['unknown'] : types.flat()
}

/**
 * The kind of value one input takes, from its schema: its `type`, else the type of its choices (`enum`, `const`),
 * else the types of its `anyOf` or `oneOf` branches, through a `$ref` to what the tool keeps beside its inputs. A
 * null type is left aside. Null for an input of several kinds, a list or an object, or one the tool doesn't take.
 */
export const inputKindOf = (schema: Record<string, unknown>, input: string): ValueKind | null => {
  const properties = propertiesOf(schema)
  const declared = Object.hasOwn(properties, input) ? properties[input] : undefined
  if (!declared) return null
  const ref = typeof declared.$ref === 'string' ? /^#\/(\$defs|definitions)\/([^/]+)$/.exec(declared.$ref) : null
  const kept = ref ? (schema[ref[1] as string] as Record<string, Record<string, unknown>> | undefined) : undefined
  const property = (ref && kept?.[ref[2] as string]) || declared
  const own = typesOf(property)
  const types = own.length > 0 ? own : branchTypesOf(property)
  const kinds = new Set(types.filter((type) => type !== 'null').map((type) => KINDS[String(type)] ?? null))
  const [kind] = kinds
  return kinds.size === 1 ? (kind ?? null) : null
}

export type InputMode = 'fixed' | 'default' | 'person'

/** Who fills an input, from what the pack stores: an input in none of the maps is the agent's. */
export const modeOf = (raw: { fixed: Fixed; defaults: Fixed; person?: Fixed }, input: string): InputMode | 'agent' =>
  Object.hasOwn(raw.fixed, input)
    ? 'fixed'
    : Object.hasOwn(raw.defaults, input)
      ? 'default'
      : raw.person && Object.hasOwn(raw.person, input)
        ? 'person'
        : 'agent'
export type InputProblem = {
  input: string
  mode: InputMode
  level: 'error' | 'warning'
  code: 'two_modes' | 'unknown_input' | 'bad_value' | 'not_a_variable' | 'not_checked' | 'person_variable' | 'no_value'
  message: string
}

const MODE_WORDS: Record<InputMode, string> = { fixed: 'fixed', default: 'a default', person: 'per person' }

/**
 * What is wrong with the values a pack sets for this tool, as stored (`{{name}}` not yet filled in). Errors: an
 * input in two modes, an input the tool doesn't take, a value its schema refuses once the variables are filled in, a
 * Per person input that is not one declared variable, and a fixed or default value that writes a variable with no
 * value of the pack's (`unset`: only a Per person input can read one). Warnings: a `{{word}}` that is no variable of
 * the pack, which is sent as written, and a value whose input has a schema that can't be read here, which is not
 * checked. Empty when fine.
 */
export const inputProblems = (
  tool: { name: string; inputSchema: Record<string, unknown> },
  raw: { fixed: Fixed; defaults: Fixed; person?: Fixed },
  variables: Variables,
  unset: string[] = [],
): InputProblem[] => {
  const properties = propertiesOf(tool.inputSchema)
  // An input in a mode before this one is said once, under the later mode
  const before: Record<InputMode, [InputMode, Fixed][]> = {
    fixed: [],
    default: [['fixed', raw.fixed]],
    person: [
      ['fixed', raw.fixed],
      ['default', raw.defaults],
    ],
  }
  const of = (mode: InputMode, values: Fixed) =>
    Object.entries(values).flatMap(([input, value]): InputProblem[] => {
      const other = before[mode].find(([, earlier]) => Object.hasOwn(earlier, input))?.[0]
      if (other)
        return [
          {
            input,
            mode,
            level: 'error',
            code: 'two_modes',
            message: `${input} is both ${MODE_WORDS[other]} and ${MODE_WORDS[mode]}: keep it in one`,
          },
        ]
      const schema = Object.hasOwn(properties, input) ? properties[input] : undefined
      if (!schema)
        return [{ input, mode, level: 'error', code: 'unknown_input', message: `${tool.name} has no input ${input}` }]
      if (mode === 'person') {
        const name = wholeNameOf(value)
        if (!name)
          return [
            {
              input,
              mode,
              level: 'error',
              code: 'person_variable',
              message: `${input} is filled per person from one variable, written {{name}} and nothing else`,
            },
          ]
        if (!Object.hasOwn(variables, name))
          return unset.includes(name)
            ? []
            : [
                {
                  input,
                  mode,
                  level: 'error',
                  code: 'person_variable',
                  message: `no variable ${name}: declare it before an input reads it per person`,
                },
              ]
      }
      const resolved = resolveValue(value, variables)
      const valueless = resolved.undeclared.filter((word) => unset.includes(word))
      if (valueless.length)
        return valueless.map((word) => ({
          input,
          mode,
          level: 'error' as const,
          code: 'no_value' as const,
          message: `{{${word}}} has no value of the pack, so only an input filled per person can read it: give it a value, or make ${input} Per person`,
        }))
      const check = checkOf(inputSchemaOf(tool.inputSchema, schema))
      return [
        ...resolved.undeclared.map((word) => ({
          input,
          mode,
          level: 'warning' as const,
          code: 'not_a_variable' as const,
          message: `no variable ${word}: sent as written`,
        })),
        ...(!check
          ? [
              {
                input,
                mode,
                level: 'warning' as const,
                code: 'not_checked' as const,
                message: `${input} is not checked: its schema can't be read here, so only a call checks it`,
              },
            ]
          : check(resolved.value)
            ? []
            : [
                {
                  input,
                  mode,
                  level: 'error' as const,
                  code: 'bad_value' as const,
                  message: `${input} ${check.errors?.[0]?.message ?? 'is invalid'}`,
                },
              ]),
      ]
    })
  return [...of('fixed', raw.fixed), ...of('default', raw.defaults), ...of('person', raw.person ?? {})]
}
