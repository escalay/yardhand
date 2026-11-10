/**
 * A tool's input schema as form fields, and the fields' text back as arguments. Plain JSON Schema only: strings,
 * numbers, booleans and enums get their own controls; arrays and objects are edited as JSON.
 */

type JsonSchema = {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  default?: unknown
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  minimum?: number
  maximum?: number
  format?: string
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
}

export type FormField = {
  name: string
  kind: 'text' | 'long-text' | 'number' | 'integer' | 'boolean' | 'choice' | 'json'
  required: boolean
  description: string | null
  choices: string[]
  /** The starting text: the default, or empty. */
  initial: string
  hint: string | null
}

const isNull = (schema: JsonSchema) => schema.type === 'null'

/** A nullable property (`anyOf: [X, {type: 'null'}]`) is read as X, its own description and default kept. */
const unwrap = (schema: JsonSchema): JsonSchema => {
  const branches = (schema.anyOf ?? schema.oneOf ?? []).filter((branch) => !isNull(branch))
  return branches.length === 1 && branches[0] ? { ...branches[0], ...withoutBranches(schema) } : schema
}
const withoutBranches = ({ anyOf: _anyOf, oneOf: _oneOf, ...rest }: JsonSchema) => rest

const typeOf = (schema: JsonSchema) =>
  Array.isArray(schema.type) ? schema.type.find((type) => type !== 'null') : schema.type

export const fieldsOf = (input: Record<string, unknown>): FormField[] => {
  const schema = input as JsonSchema
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([name, raw]) => {
    const property = unwrap(raw)
    const type = typeOf(property)
    const kind: FormField['kind'] = property.enum?.length
      ? 'choice'
      : type === 'boolean'
        ? 'boolean'
        : type === 'integer'
          ? 'integer'
          : type === 'number'
            ? 'number'
            : type === 'array' || type === 'object'
              ? 'json'
              : (property.description?.length ?? 0) > 160 || /text|body|content|prompt|query/i.test(name)
                ? 'long-text'
                : 'text'
    const initial =
      property.default === undefined || property.default === null
        ? ''
        : kind === 'json'
          ? JSON.stringify(property.default, null, 2)
          : String(property.default)
    const range =
      property.minimum !== undefined || property.maximum !== undefined
        ? `${property.minimum ?? '…'}–${property.maximum ?? '…'}`
        : null
    return {
      name,
      kind,
      required: required.has(name),
      description: property.description ?? null,
      choices: (property.enum ?? []).map(String),
      initial,
      hint:
        [kind === 'json' ? (type === 'array' ? 'a JSON list' : 'a JSON object') : type, range, property.format]
          .filter(Boolean)
          .join(' · ') || null,
    }
  })
}

/** Field text → arguments. Empty optional fields are left out so the tool's own defaults apply. */
export const argumentsOf = (fields: FormField[], values: Record<string, string>) => {
  const args: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const raw = values[field.name] ?? ''
    if (raw.trim() === '') {
      if (field.required && field.kind !== 'boolean') errors[field.name] = 'Required.'
      continue
    }
    if (field.kind === 'number' || field.kind === 'integer') {
      const number = Number(raw)
      if (Number.isNaN(number) || (field.kind === 'integer' && !Number.isInteger(number)))
        errors[field.name] = field.kind === 'integer' ? 'A whole number.' : 'A number.'
      else args[field.name] = number
    } else if (field.kind === 'boolean') args[field.name] = raw === 'true'
    else if (field.kind === 'json')
      try {
        args[field.name] = JSON.parse(raw)
      } catch {
        errors[field.name] = 'Not valid JSON.'
      }
    else args[field.name] = raw
  }
  return { args, errors }
}

/** Arguments (from a past call) → field text, so "Run again" fills the form. */
export const valuesOf = (fields: FormField[], args: Record<string, unknown>) =>
  Object.fromEntries(
    fields.map((field) => {
      const value = args[field.name]
      if (value === undefined) return [field.name, field.initial]
      return [field.name, field.kind === 'json' ? JSON.stringify(value, null, 2) : String(value)]
    }),
  )
