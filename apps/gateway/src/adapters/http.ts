/**
 * Plain REST APIs as tools. From an OpenAPI 3.x spec each operation becomes a tool (its parameters and JSON body
 * become one input object); endpoints can also be defined by hand. Calls are plain HTTP with the upstream's
 * credential; the answer comes back as text plus typed JSON.
 */
import { EMPTY_LISTING } from '../features/catalog/content.js'
import { ProblemError } from '../kit/index.js'
import {
  type Adapter,
  authHeaders,
  type Credential,
  type Endpoint,
  type Listing,
  type RemoteTool,
  type ToolResult,
} from './index.js'

const TIMEOUT_MS = 60_000
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
type Method = (typeof METHODS)[number]
type Json = Record<string, unknown>

/** One operation the adapter can call: where it goes and which inputs land where. */
export type Operation = {
  name: string
  method: Method
  path: string
  title?: string
  description: string
  /** Input names that fill `{name}` in the path, go in the query, or (`body`) are the JSON body. */
  pathParams: string[]
  queryParams: string[]
  hasBody: boolean
  inputSchema: Json
}

/** What an `http` upstream keeps in its config: the spec to read, or endpoints written by hand, and which to expose. */
export type HttpConfig = {
  spec?: string
  operations?: string[]
  endpoints?: { name: string; method: Method; path: string; description: string; input?: Json; body?: boolean }[]
}

const snake = (text: string) =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 64)

/** Inlines local `$ref`s (`#/components/...`), stopping at cycles and depth 8 so a recursive schema stays finite. */
const resolver = (doc: Json) => {
  const at = (ref: string) =>
    ref
      .replace(/^#\//, '')
      .split('/')
      .reduce<unknown>((node, key) => (node as Json | undefined)?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc)
  const resolve = (node: unknown, seen: string[] = [], depth = 0): unknown => {
    if (Array.isArray(node)) return node.map((item) => resolve(item, seen, depth))
    if (!node || typeof node !== 'object') return node
    const ref = (node as Json).$ref
    if (typeof ref === 'string' && ref.startsWith('#/')) {
      if (seen.includes(ref) || depth > 8) return { type: 'object', description: `(recursive ${ref.split('/').pop()})` }
      return resolve(at(ref), [...seen, ref], depth + 1)
    }
    return Object.fromEntries(Object.entries(node as Json).map(([key, value]) => [key, resolve(value, seen, depth)]))
  }
  return resolve
}

type Parameter = { name: string; in: string; required?: boolean; description?: string; schema?: Json }

/** Every operation in an OpenAPI 3.x document, as tools the gateway can serve. */
export const operationsOf = (doc: Json): Operation[] => {
  const resolve = resolver(doc)
  const found: Operation[] = []
  for (const [path, item] of Object.entries((doc.paths ?? {}) as Record<string, Json>)) {
    const shared = ((item.parameters ?? []) as unknown[]).map((parameter) => resolve(parameter) as Parameter)
    for (const method of METHODS) {
      const operation = item[method] as Json | undefined
      if (!operation) continue
      const parameters = [
        ...shared,
        ...((operation.parameters ?? []) as unknown[]).map((parameter) => resolve(parameter) as Parameter),
      ].filter((parameter) => parameter.in === 'path' || parameter.in === 'query')
      const body = resolve(operation.requestBody) as
        | { required?: boolean; content?: Record<string, { schema?: Json }> }
        | undefined
      const bodySchema =
        body?.content?.['application/json']?.schema ??
        Object.entries(body?.content ?? {}).find(([type]) => type.endsWith('+json'))?.[1]?.schema
      const properties: Json = Object.fromEntries(
        parameters.map((parameter) => [
          parameter.name,
          {
            ...(parameter.schema ?? { type: 'string' }),
            ...(parameter.description ? { description: parameter.description } : {}),
          },
        ]),
      )
      const required = parameters
        .filter((parameter) => parameter.required || parameter.in === 'path')
        .map((parameter) => parameter.name)
      if (bodySchema) {
        properties.body = {
          ...bodySchema,
          description: (bodySchema.description as string | undefined) ?? 'The JSON body.',
        }
        if (body?.required) required.push('body')
      }
      const summary = operation.summary as string | undefined
      found.push({
        name: snake((operation.operationId as string | undefined) ?? `${method}_${path}`),
        method,
        path,
        title: summary,
        description:
          [summary, operation.description as string | undefined].filter(Boolean).join('\n\n') ||
          `${method.toUpperCase()} ${path}`,
        pathParams: parameters.filter((parameter) => parameter.in === 'path').map((parameter) => parameter.name),
        queryParams: parameters.filter((parameter) => parameter.in === 'query').map((parameter) => parameter.name),
        hasBody: Boolean(bodySchema),
        inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
      })
    }
  }
  return found
}

/** Endpoints written by hand, in the same shape. */
export const manualOperations = (config: HttpConfig): Operation[] =>
  (config.endpoints ?? []).map((endpoint) => {
    const input = (endpoint.input ?? {}) as Record<string, Json>
    const pathParams = [...endpoint.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string)
    const fields = Object.keys(input).filter((name) => !pathParams.includes(name))
    const body = endpoint.body ?? endpoint.method !== 'get'
    return {
      name: snake(endpoint.name),
      method: endpoint.method,
      path: endpoint.path,
      description: endpoint.description,
      pathParams,
      queryParams: body ? [] : fields,
      hasBody: false,
      // A hand-made endpoint sends its non-path fields as the body (or the query, for GET)
      bodyFields: body ? fields : [],
      inputSchema: {
        type: 'object',
        properties: input,
        required: Object.keys(input).filter((name) => !(input[name] as Json).optional),
      },
    } as Operation & { bodyFields: string[] }
  })

const annotationsOf = (method: Method) => ({
  readOnlyHint: method === 'get',
  destructiveHint: method === 'delete',
  idempotentHint: method === 'get' || method === 'put' || method === 'delete',
  openWorldHint: true,
})

export const httpAdapter = (): Adapter => {
  const cache = new Map<string, { at: number; operations: (Operation & { base: string })[] }>()

  const load = async (endpoint: Endpoint, credential: Credential | undefined) => {
    const config = (endpoint.config ?? {}) as HttpConfig
    const cached = cache.get(endpoint.id)
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached
    // Hand-made endpoints sit under the upstream url; spec operations under the spec's first server
    let operations: (Operation & { base: string })[] = manualOperations(config).map((operation) => ({
      ...operation,
      base: endpoint.url,
    }))
    if (config.spec) {
      const specUrl = new URL(config.spec, endpoint.url)
      const response = await fetch(specUrl, {
        headers: { accept: 'application/json', ...authHeaders(endpoint, credential) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch((error: unknown) => {
        throw new ProblemError('upstream', {
          detail: `${endpoint.id}: could not read ${specUrl} (${error instanceof Error ? error.message : error})`,
        })
      })
      if (!response.ok)
        throw new ProblemError('upstream', { detail: `${endpoint.id}: ${specUrl} answered ${response.status}` })
      const doc = (await response.json()) as Json
      const server = ((doc.servers ?? []) as { url?: string }[])[0]?.url
      const base = server ? new URL(server, specUrl).toString() : endpoint.url
      const wanted = config.operations?.length ? new Set(config.operations.map(snake)) : null
      operations = [
        ...operations,
        ...operationsOf(doc)
          .filter((operation) => !wanted || wanted.has(operation.name))
          .map((operation) => ({ ...operation, base })),
      ]
    }
    const loaded = { at: Date.now(), operations }
    cache.set(endpoint.id, loaded)
    return loaded
  }

  return {
    list: async (endpoint, credential): Promise<Listing> => {
      cache.delete(endpoint.id)
      const { operations } = await load(endpoint, credential)
      const tools: RemoteTool[] = operations.map((operation) => ({
        name: operation.name,
        title: operation.title ?? null,
        description: operation.description,
        inputSchema: operation.inputSchema,
        outputSchema: null,
        annotations: annotationsOf(operation.method),
        route: `${operation.method.toUpperCase()} ${operation.path}`,
      }))
      return { tools, instructions: null, server: null, catalog: EMPTY_LISTING }
    },
    call: async (endpoint, credential, name, args): Promise<ToolResult> => {
      const { operations } = await load(endpoint, credential)
      const operation = operations.find((candidate) => candidate.name === name) as
        | (Operation & { base: string; bodyFields?: string[] })
        | undefined
      if (!operation)
        throw new ProblemError('not_found', { detail: `${endpoint.id} has no operation ${name}; sync the upstream.` })
      const path = operation.path.replace(/\{([^}]+)\}/g, (_, key: string) =>
        encodeURIComponent(String(args[key] ?? '')),
      )
      const url = new URL(path.replace(/^\//, ''), operation.base.endsWith('/') ? operation.base : `${operation.base}/`)
      for (const key of operation.queryParams) {
        const value = args[key]
        if (value === undefined || value === null) continue
        for (const item of Array.isArray(value) ? value : [value])
          url.searchParams.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item))
      }
      const body = operation.hasBody
        ? args.body
        : operation.bodyFields?.length
          ? Object.fromEntries(operation.bodyFields.filter((key) => key in args).map((key) => [key, args[key]]))
          : undefined
      const response = await fetch(url, {
        method: operation.method.toUpperCase(),
        headers: {
          accept: 'application/json, */*;q=0.5',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...authHeaders(endpoint, credential),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch((error: unknown) => {
        throw new ProblemError('upstream', {
          detail: `${endpoint.id}: ${operation.method.toUpperCase()} ${url.pathname} failed (${error instanceof Error ? error.message : error})`,
        })
      })
      const raw = await response.text()
      const json = /json/.test(response.headers.get('content-type') ?? '')
        ? (() => {
            try {
              return JSON.parse(raw) as unknown
            } catch {
              return undefined
            }
          })()
        : undefined
      const text = json === undefined ? raw : JSON.stringify(json, null, 1)
      return {
        content: [{ type: 'text', text: response.ok ? text : `HTTP ${response.status}: ${text}` }],
        ...(json && typeof json === 'object' && !Array.isArray(json) ? { structuredContent: json } : {}),
        ...(response.ok ? {} : { isError: true }),
      }
    },
    getPrompt: async (endpoint) => {
      throw new ProblemError('not_found', { detail: `${endpoint.id} is a REST API: it has no playbooks.` })
    },
    readResource: async (endpoint) => {
      throw new ProblemError('not_found', {
        detail: `${endpoint.id} is a REST API: its links are read through GET /u/${endpoint.id}/r/<path>.`,
      })
    },
    // A REST API announces nothing: the hourly sync is how its changes arrive
    watch: async () => null,
    forget: async (upstreamId) => {
      cache.delete(upstreamId)
    },
  }
}
