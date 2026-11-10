/**
 * Arguments checked against the tool's own JSON Schema before the upstream sees them, so a wrong argument is a 400
 * problem listing every bad field, the same as any other route, instead of an error buried in the tool's result.
 */
import { Ajv } from '@modelcontextprotocol/client/validators/ajv'
import { ProblemError } from '../../kit/index.js'

// useDefaults fills an omitted argument that has a default before `required` is checked, as the upstream would
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, useDefaults: true })
type Check = ((data: unknown) => boolean) & {
  errors?: { instancePath: string; keyword?: string; message?: string; params?: Record<string, unknown> }[] | null
}
const compiled = new Map<string, Check | null>()

/** A validator per tool version; a schema ajv can't compile is not checked here (the upstream still checks it). */
const checkOf = (versionId: string, schema: Record<string, unknown>) => {
  if (!compiled.has(versionId)) {
    try {
      const { $schema: _, ...rest } = schema
      compiled.set(versionId, ajv.compile(rest) as Check)
    } catch {
      compiled.set(versionId, null)
    }
  }
  return compiled.get(versionId) ?? null
}

/**
 * The arguments with their schema defaults filled in, ready for the upstream; throws a `bad_request` problem naming
 * every argument that doesn't match the tool's input schema.
 */
export const checkArguments = (
  tool: { name: string; versionId: string; inputSchema: Record<string, unknown> },
  args: Record<string, unknown>,
) => {
  const check = checkOf(tool.versionId, tool.inputSchema)
  const filled = structuredClone(args)
  if (!check || check(filled)) return filled
  const errors = (check.errors ?? []).map((error) => {
    const missing = typeof error.params?.missingProperty === 'string' ? `/${error.params.missingProperty}` : ''
    const extra = typeof error.params?.additionalProperty === 'string' ? `/${error.params.additionalProperty}` : ''
    return {
      in: 'body' as const,
      path: `arguments${(error.instancePath + missing + extra).replaceAll('/', '.')}`,
      message: error.keyword === 'required' ? 'is required' : (error.message ?? 'is invalid'),
    }
  })
  throw new ProblemError('bad_request', {
    detail: `The arguments don't match ${tool.name}'s input schema (${errors.map((error) => `${error.path} ${error.message}`).join('; ')}). GET /api/tools/${tool.name} shows it.`,
    errors,
  })
}
