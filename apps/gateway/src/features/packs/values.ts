/**
 * A pack's variables, written `{{name}}` in the values it fixes or gives as defaults. Only a name the pack declares is
 * a variable: any other `{{word}}` is left exactly as written, so a tool whose own input is a template keeps working
 * and nothing needs escaping.
 */

/** A variable's name: lowercase words joined by `_`. */
export const VARIABLE = /^[a-z][a-z0-9_]{0,39}$/
/** The most variables a pack holds, and the longest description one has. */
export const VARIABLES_MAX = 100
export const VARIABLE_DESCRIPTION_MAX = 400

export type Scalar = string | number | boolean
/** A pack's variables by name. */
export type Variables = Record<string, Scalar>

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g
const WHOLE = /^\{\{\s*([a-z][a-z0-9_]*)\s*\}\}$/

const unique = (names: string[]) => [...new Set(names)]
const declares = (variables: Variables, name: string) => Object.hasOwn(variables, name)

/** The stored variables by name, each value with its type; one with no value yet is not a variable. */
export const variablesFrom = (rows: { name: string; value: string | null }[]): Variables =>
  Object.fromEntries(rows.flatMap((row) => (row.value === null ? [] : [[row.name, JSON.parse(row.value) as Scalar]])))

/** The names written as `{{name}}` in a text, each once, in order. */
export const placeholdersIn = (text: string) => unique([...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ''))

/** Every `{{…}}` in a text that is not written as a name, each once: nothing fills these in. */
export const notNamesIn = (text: string) =>
  unique(
    [...text.matchAll(/\{\{([^{}]*)\}\}/g)]
      .filter((match) => !/^\s*[a-z][a-z0-9_]*\s*$/.test(match[1] ?? ''))
      .map((match) => match[0]),
  )

/** The variable a value names when it is `{{name}}` and nothing else, else undefined. */
export const wholeNameOf = (value: unknown) => (typeof value === 'string' ? WHOLE.exec(value)?.[1] : undefined)

/** The names written as `{{name}}` anywhere in a value, each once. */
export const namesIn = (value: unknown): string[] =>
  typeof value === 'string'
    ? placeholdersIn(value)
    : value && typeof value === 'object'
      ? unique(Object.values(value).flatMap(namesIn))
      : []

const split = (text: string, variables: Variables) => {
  const names = placeholdersIn(text)
  return {
    used: names.filter((name) => declares(variables, name)),
    undeclared: names.filter((name) => !declares(variables, name)),
  }
}

/** A text with the pack's variables filled in; `undeclared` are the words left as written. */
export const resolveText = (text: string, variables: Variables) => ({
  text: text.replace(PLACEHOLDER, (whole, name: string) =>
    declares(variables, name) ? String(variables[name]) : whole,
  ),
  ...split(text, variables),
})

/**
 * A value with the pack's variables filled in: a string that is one variable and nothing else takes the variable's
 * value with its type, a variable inside longer text becomes text, and arrays and objects are walked.
 */
export const resolveValue = (
  value: unknown,
  variables: Variables,
): { value: unknown; used: string[]; undeclared: string[] } => {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value)?.[1]
    if (whole && declares(variables, whole)) return { value: variables[whole], used: [whole], undeclared: [] }
    const { text, used, undeclared } = resolveText(value, variables)
    return { value: text, used, undeclared }
  }
  if (!value || typeof value !== 'object') return { value, used: [], undeclared: [] }
  const parts = Object.entries(value).map(([key, inner]) => [key, resolveValue(inner, variables)] as const)
  return {
    value: Array.isArray(value)
      ? parts.map(([, part]) => part.value)
      : Object.fromEntries(parts.map(([key, part]) => [key, part.value])),
    used: unique(parts.flatMap(([, part]) => part.used)),
    undeclared: unique(parts.flatMap(([, part]) => part.undeclared)),
  }
}
