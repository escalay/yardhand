/** A JSON Schema as a TypeScript type, for the shapes tool inputs use; anything it doesn't know becomes `unknown`. */
type Schema = Record<string, unknown>

const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name))

export const typeOf = (schema: unknown, indent = ''): string => {
  if (!schema || typeof schema !== 'object') return 'unknown'
  const node = schema as Schema
  if (Array.isArray(node.enum)) return node.enum.map((value) => JSON.stringify(value)).join(' | ') || 'never'
  if ('const' in node) return JSON.stringify(node.const)
  for (const union of ['anyOf', 'oneOf'] as const)
    if (Array.isArray(node[union])) return (node[union] as unknown[]).map((part) => typeOf(part, indent)).join(' | ')
  if (Array.isArray(node.allOf)) return (node.allOf as unknown[]).map((part) => typeOf(part, indent)).join(' & ')
  const types = Array.isArray(node.type) ? (node.type as string[]) : node.type ? [node.type as string] : []
  if (types.length > 1) return types.map((type) => typeOf({ ...node, type }, indent)).join(' | ')
  switch (types[0] ?? (node.properties ? 'object' : undefined)) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array':
      return `Array<${typeOf(node.items, indent)}>`
    case 'object': {
      const properties = (node.properties ?? {}) as Record<string, unknown>
      const required = new Set((node.required ?? []) as string[])
      const names = Object.keys(properties)
      const rest =
        node.additionalProperties && typeof node.additionalProperties === 'object'
          ? typeOf(node.additionalProperties, indent)
          : null
      if (!names.length) return rest ? `Record<string, ${rest}>` : 'Record<string, unknown>'
      const inner = `${indent}  `
      const lines = names.map((name) => {
        const property = properties[name] as Schema
        // A default means the gateway fills it in, so it may be left out
        const optional = !required.has(name) || property?.default !== undefined
        const doc =
          typeof property?.description === 'string'
            ? `${inner}/** ${property.description.replace(/\s+/g, ' ').replaceAll('*/', '* /').slice(0, 200)} */\n`
            : ''
        return `${doc}${inner}${key(name)}${optional ? '?' : ''}: ${typeOf(property, inner)}`
      })
      return `{\n${lines.join('\n')}\n${indent}}`
    }
    default:
      return 'unknown'
  }
}
