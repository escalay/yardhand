import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { hashApiKey, testDb } from '../../kit/index.js'
import { PACK_PATHS, packGuide, packOpenApi } from './docs.js'

const KEY = 'docs-test-key'
const app = await createApp({
  db: await testDb(),
  env: { API_KEYS: `owner:${hashApiKey(KEY)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
})
const read = async (path: string) => (await app.request(path, { headers: { authorization: `Bearer ${KEY}` } })).json()
const PACK = { name: 'desk', title: 'Front desk', description: 'Greets for the desk.\n\nSecond paragraph.' }
const URL = 'https://gw.example.com/p/desk'

/** Every `$ref` anywhere in a document. */
const refsIn = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(refsIn)
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, inner]) => (key === '$ref' ? [String(inner)] : refsIn(inner)))
      : []

describe('a pack’s OpenAPI document', () => {
  it('holds only the routes a pack serves and its tools, with every reference resolved', async () => {
    const gateway = (await read('/openapi.json')) as Parameters<typeof packOpenApi>[0]['gateway']
    const tools = {
      tags: [{ name: 'fixture', description: 'Tools from upstream fixture.' }],
      paths: {
        '/api/tools/greet_from_desk/calls': {
          post: {
            operationId: 'greetFromDesk',
            tags: ['fixture'],
            responses: {
              200: { content: { 'application/hal+json': { schema: { $ref: '#/components/schemas/CallResult' } } } },
              400: { content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } },
            },
          },
        },
      },
      components: { schemas: { CallResult: { type: 'object' }, OnlyInTools: { type: 'string' } } },
    }
    const doc = packOpenApi({ gateway, tools, pack: PACK, url: URL })
    // A route renamed in the gateway must be renamed here too
    for (const [path, methods] of Object.entries(PACK_PATHS))
      expect([path, methods.filter((method) => method in (gateway.paths[path] ?? {}))]).toEqual([path, methods])
    expect(Object.keys(doc.paths).sort()).toEqual(
      [...Object.keys(PACK_PATHS), '/api/tools/greet_from_desk/calls'].sort(),
    )
    expect(Object.keys(doc.paths['/api/tools/{name}'] ?? {})).toEqual(['get'])
    expect(Object.keys(doc.paths['/api/upstreams'] ?? {})).toEqual(['get'])
    expect(doc.info).toMatchObject({ title: 'Front desk', version: gateway.info.version })
    expect(doc.info.description).toContain('Greets for the desk.')
    expect(doc.servers).toEqual([{ url: URL, description: 'The Front desk pack' }])
    const schemas = doc.components.schemas as Record<string, unknown>
    expect(refsIn(doc).filter((ref) => !(ref.replace('#/components/schemas/', '') in schemas))).toEqual([])
    // The gateway's own schema wins a shared name; one only the tools define comes along
    expect(schemas.CallResult).toEqual((gateway.components.schemas as Record<string, unknown>).CallResult)
    expect(schemas.OnlyInTools).toEqual({ type: 'string' })
    expect(doc.tags.map((tag) => tag.name)).toContain('fixture')
    expect(doc.tags.map((tag) => tag.name)).not.toContain('Packs')
  })
})

describe('a pack’s OpenAPI document on a gateway agents can sign in to', () => {
  it('offers a key only: a pack’s address takes no OAuth sign-in', async () => {
    const plain = (await read('/openapi.json')) as Parameters<typeof packOpenApi>[0]['gateway']
    const gateway = {
      ...plain,
      security: [...(plain.security ?? []), { oauth: ['read', 'write'] }],
      components: {
        ...plain.components,
        securitySchemes: { ...plain.components.securitySchemes, oauth: { type: 'oauth2' } },
      },
    }
    const doc = packOpenApi({ gateway, tools: { paths: {} }, pack: PACK, url: URL })
    expect(doc.security).toEqual([{ apiKey: [] }])
    expect(Object.keys(doc.components.securitySchemes ?? {})).toEqual(['apiKey'])
  })
})

describe('a pack’s guide', () => {
  const guide = packGuide({
    pack: PACK,
    url: URL,
    readOnly: true,
    tools: [
      { name: 'greet_from_desk', title: 'Greet', summary: 'Greets someone from the desk.', needsWrite: false },
      { name: 'fixture.shout', title: null, summary: 'Shouts.', needsWrite: true },
    ],
    playbooks: [{ name: 'fixture-warm-up', title: 'Fixture · Warm up', description: 'Warms up.' }],
    manuals: [{ name: 'fixture', upstream: 'fixture', description: 'How to use the fixture.' }],
  })

  it('prints the pack, its addresses and what it was given', () => {
    expect(guide).toMatch(/^# Front desk\n\nGreets for the desk\.\n\nSecond paragraph\./)
    expect(guide).toContain('`https://gw.example.com/p/desk/mcp`')
    expect(guide).toContain('`https://gw.example.com/p/desk/api`')
    expect(guide).toContain('## Tools (2)')
    expect(guide).toContain('- `greet_from_desk`: Greet. Greets someone from the desk.')
    expect(guide).toContain('- `fixture.shout` [changes things]: Shouts.')
    expect(guide).toContain('- `fixture-warm-up`: Fixture · Warm up. Warms up.')
    expect(guide).toContain('- `fixture` (`gateway://u/fixture/manual`): How to use the fixture.')
    expect(guide).toContain('This key is read-only')
  })

  it('says how the inputs a pack sets read to its keys, as the gateway’s guide does', () => {
    const flat = guide.replace(/\s+/g, ' ')
    expect(flat).toContain(
      "An input the pack fills itself is not in the tool's schema: leave it out, a call that sends it is refused (400).",
    )
    expect(flat).toContain(
      'An input the pack gives a default shows that default in the schema; send your own value to replace it.',
    )
  })

  it('leaves out the sections it has nothing for, and says when the pack holds no tools', () => {
    const empty = packGuide({ pack: PACK, url: URL, readOnly: false, tools: [], playbooks: [], manuals: [] })
    expect(empty).toContain('## Tools (0)')
    expect(empty).toContain('This pack holds no tools this key can use.')
    expect(empty).not.toContain('## Playbooks')
    expect(empty).not.toContain('## Manuals')
    expect(empty).not.toContain('read-only')
  })
})
