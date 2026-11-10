/**
 * A pack tool as its keys see it. The pack may call it by its own name (an alias, so one tool can sit in a pack more
 * than once, say once per account) and may fix some of its inputs: the gateway fills those on every call and takes
 * them off the schema its keys read, so an agent can neither see nor change them.
 */
import { Ajv } from '@modelcontextprotocol/client/validators/ajv'

/** An alias: lowercase words joined by `_` or `-`. It has no dot, so it never clashes with an `<upstream>.<tool>`. */
export const ALIAS = /^[a-z][a-z0-9_-]{1,63}$/

export type Fixed = Record<string, unknown>

/** One name in a pack: the tool it runs, the pack's wording and what it fixes. */
export type PackEntry = { tool: string; wording: string | null; fixed: Fixed }

export const fixedOf = (row: { fixed: string | null }): Fixed => (row.fixed ? (JSON.parse(row.fixed) as Fixed) : {})

const propertiesOf = (schema: Record<string, unknown>) =>
  (schema.properties ?? {}) as Record<string, Record<string, unknown>>

/** The input schema without the fixed inputs: they are neither shown nor required. */
export const withoutFixed = (schema: Record<string, unknown>, fixed: Fixed): Record<string, unknown> => {
  const names = Object.keys(fixed)
  if (!names.length) return schema
  const properties = Object.fromEntries(Object.entries(propertiesOf(schema)).filter(([key]) => !names.includes(key)))
  const required = Array.isArray(schema.required)
    ? (schema.required as string[]).filter((key) => !names.includes(key))
    : undefined
  return { ...schema, properties, ...(required ? { required } : {}) }
}

/** The tool as one entry of a pack shows it: the entry's name and wording, and the schema without what it fixes. */
export const presented = <T extends { name: string; description: string; inputSchema: Record<string, unknown> }>(
  tool: T,
  name: string,
  entry: Pick<PackEntry, 'wording' | 'fixed'>,
): T => ({
  ...tool,
  name,
  description: entry.wording ?? tool.description,
  inputSchema: withoutFixed(tool.inputSchema, entry.fixed),
})

/** Fixed inputs the tool's schema no longer has: the upstream dropped or renamed them. */
export const lostInputs = (schema: Record<string, unknown>, fixed: Fixed) => {
  const properties = propertiesOf(schema)
  return Object.keys(fixed).filter((key) => !(key in properties))
}

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false })

/** What is wrong with fixed values for this tool: inputs it doesn't take, values its schema refuses. Empty when fine. */
export const fixedProblems = (tool: { name: string; inputSchema: Record<string, unknown> }, fixed: Fixed) => {
  const properties = propertiesOf(tool.inputSchema)
  return Object.entries(fixed).flatMap(([key, value]) => {
    const schema = properties[key]
    if (!schema) return [`${tool.name} has no input ${key}`]
    try {
      const check = ajv.compile(schema)
      return check(value) ? [] : [`${key} ${check.errors?.[0]?.message ?? 'is invalid'}`]
    } catch {
      return []
    }
  })
}
