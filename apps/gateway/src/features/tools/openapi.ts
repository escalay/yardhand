/**
 * The tools themselves as an OpenAPI 3.1 document: one operation per tool the caller may use, at
 * `POST /api/tools/{name}/calls`, with the tool's own input schema as the body. Generate a typed client from it.
 */
import { type LiveTool, needsWrite } from './repo.js'

const camel = (name: string) =>
  name.replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) => (next ? next.toUpperCase() : ''))

/** MCP tool schemas are JSON Schema 2020-12, which OpenAPI 3.1 takes as is; only `$schema` has no place inside. */
const clean = (schema: Record<string, unknown>) => {
  const { $schema: _, ...rest } = schema
  return rest
}

export const toolsOpenApi = ({ origin, tools, version }: { origin: string; tools: LiveTool[]; version: string }) => ({
  openapi: '3.1.0',
  info: {
    title: 'Yardhand tools',
    version,
    description:
      'Every tool this key may use, as an operation. Each runs through the gateway with its stored credentials and answers a CallResult; problems are application/problem+json. The gateway’s own API is at /openapi.json.',
  },
  servers: [{ url: origin }],
  security: [{ bearer: [] }],
  tags: [...new Set(tools.map((tool) => tool.upstreamId))]
    .sort()
    .map((name) => ({ name, description: `Tools from upstream ${name}.` })),
  paths: Object.fromEntries(
    tools.map((tool) => [
      `/api/tools/${tool.name}/calls`,
      {
        post: {
          operationId: camel(tool.name),
          summary: tool.title ?? tool.name,
          description: tool.description,
          tags: [tool.upstreamId],
          'x-needs-write': needsWrite(tool),
          'x-mcp-annotations': tool.annotations,
          requestBody: { required: true, content: { 'application/json': { schema: clean(tool.inputSchema) } } },
          responses: {
            200: {
              description: 'The tool ran; `result` is what it returned (`result.isError` when it reported an error).',
              content: {
                'application/hal+json': {
                  schema: tool.outputSchema
                    ? {
                        allOf: [
                          { $ref: '#/components/schemas/CallResult' },
                          {
                            type: 'object',
                            properties: {
                              result: { type: 'object', properties: { structuredContent: clean(tool.outputSchema) } },
                            },
                          },
                        ],
                      }
                    : { $ref: '#/components/schemas/CallResult' },
                },
              },
            },
            ...Object.fromEntries(
              [
                [400, 'The arguments do not match the input schema.'],
                [401, 'No valid key or token.'],
                [403, 'This client may not run it (read-only, or revoked).'],
                [404, 'No such tool for this client.'],
                [429, 'Too many calls: wait the seconds in Retry-After.'],
                [502, 'The upstream failed.'],
                [503, 'The upstream is switched off.'],
              ].map(([status, description]) => [
                status,
                {
                  description,
                  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
                },
              ]),
            ),
          },
        },
      },
    ]),
  ),
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer', description: 'A gateway client key or an OAuth access token.' },
    },
    schemas: {
      CallResult: {
        type: 'object',
        required: ['id', 'tool', 'status', 'durationMs', 'result', '_links'],
        properties: {
          id: { type: 'string', description: 'The call id, for GET /api/calls/{id}.' },
          tool: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'tool_error'] },
          durationMs: { type: 'integer' },
          result: {
            type: 'object',
            properties: {
              content: { type: 'array', items: { type: 'object' }, description: 'MCP content blocks.' },
              structuredContent: { description: 'Typed JSON, when the tool declares an output schema.' },
              isError: { type: 'boolean' },
            },
          },
          held: { type: ['object', 'null'] },
          _links: { type: 'object' },
        },
      },
      Problem: {
        type: 'object',
        description: 'RFC 9457 problem details.',
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'integer' },
          detail: { type: 'string' },
          code: { type: 'string' },
        },
      },
    },
  },
})
