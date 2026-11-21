/**
 * A pack tool as its keys see it. The pack may call it by its own name (an alias, so one tool can sit in a pack more
 * than once, say once per account) and sets some of its inputs. A fixed input is filled on every call and taken off
 * the schema its keys read, so an agent can neither see nor change it. A default is shown with the pack's value and
 * filled when the agent sends nothing. Either value may write the pack's variables as `{{name}}`.
 */
import { Ajv } from '@modelcontextprotocol/client/validators/ajv'
import { resolveValue, type Variables } from './values.js'

/** An alias: lowercase words joined by `_` or `-`. It has no dot, so it never clashes with an `<upstream>.<tool>`. */
export const ALIAS = /^[a-z][a-z0-9_-]{1,63}$/

/** Values by input name: what a pack fixes, or what it gives as defaults. */
export type Fixed = Record<string, unknown>

/** One name in a pack: the tool it runs, the pack's wording, and what it fixes and defaults, variables filled in. */
export type PackEntry = { tool: string; wording: string | null; fixed: Fixed; defaults: Fixed }

export const fixedOf = (row: { fixed: string | null }): Fixed => (row.fixed ? (JSON.parse(row.fixed) as Fixed) : {})
export const defaultsOf = (row: { defaults: string | null }): Fixed =>
  row.defaults ? (JSON.parse(row.defaults) as Fixed) : {}

const filled = (values: Fixed, variables: Variables): Fixed =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, resolveValue(value, variables).value]))

/** A stored pack tool as an entry, with the pack's variables filled into its values. */
export const resolveEntry = (
  row: { toolName: string; description: string | null; fixed: string | null; defaults: string | null },
  variables: Variables,
): PackEntry => ({
  tool: row.toolName,
  wording: row.description,
  fixed: filled(fixedOf(row), variables),
  defaults: filled(defaultsOf(row), variables),
})

const propertiesOf = (schema: Record<string, unknown>) =>
  (schema.properties ?? {}) as Record<string, Record<string, unknown>>

/**
 * The input schema as a pack's keys read it: without the fixed inputs, which are neither shown nor required, and
 * with each default as the input's `default`, no longer required.
 */
export const shownSchema = (
  schema: Record<string, unknown>,
  entry: Pick<PackEntry, 'fixed' | 'defaults'>,
): Record<string, unknown> => {
  const hidden = Object.keys(entry.fixed)
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
  entry: Pick<PackEntry, 'wording' | 'fixed' | 'defaults'>,
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

export type InputMode = 'fixed' | 'default'

/** Who fills an input, from what the pack stores: an input in neither map is the agent's. */
export const modeOf = (raw: { fixed: Fixed; defaults: Fixed }, input: string): InputMode | 'agent' =>
  Object.hasOwn(raw.fixed, input) ? 'fixed' : Object.hasOwn(raw.defaults, input) ? 'default' : 'agent'
export type InputProblem = {
  input: string
  mode: InputMode
  level: 'error' | 'warning'
  code: 'two_modes' | 'unknown_input' | 'bad_value' | 'not_a_variable' | 'not_checked'
  message: string
}

/**
 * What is wrong with the values a pack sets for this tool, as stored (`{{name}}` not yet filled in). Errors: an
 * input in both modes, an input the tool doesn't take, a value its schema refuses once the variables are filled in.
 * Warnings: a `{{word}}` that is no variable of the pack, which is sent as written, and a value whose input has a
 * schema that can't be read here, which is not checked. Empty when fine.
 */
export const inputProblems = (
  tool: { name: string; inputSchema: Record<string, unknown> },
  raw: { fixed: Fixed; defaults: Fixed },
  variables: Variables,
): InputProblem[] => {
  const properties = propertiesOf(tool.inputSchema)
  const of = (mode: InputMode, values: Fixed) =>
    Object.entries(values).flatMap(([input, value]): InputProblem[] => {
      if (mode === 'default' && Object.hasOwn(raw.fixed, input))
        return [
          {
            input,
            mode,
            level: 'error',
            code: 'two_modes',
            message: `${input} is both fixed and a default: keep it in one`,
          },
        ]
      const schema = Object.hasOwn(properties, input) ? properties[input] : undefined
      if (!schema)
        return [{ input, mode, level: 'error', code: 'unknown_input', message: `${tool.name} has no input ${input}` }]
      const resolved = resolveValue(value, variables)
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
  return [...of('fixed', raw.fixed), ...of('default', raw.defaults)]
}
