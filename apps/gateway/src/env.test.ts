import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { addressTrustOf, EXAMPLE_HEADER, IMAGE_SETS, problemsOf, renderEnv, settings } from './env.js'
import { hashApiKey } from './kit/index.js'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const good = { GATEWAY_MASTER_KEY: randomBytes(32).toString('base64'), API_KEYS: `owner:${hashApiKey('k')}` }

describe('the settings', () => {
  it('are the ones the container passes in, no more and no fewer', () => {
    const passed = [...read('../container/entrypoint.sh').matchAll(/\$\{([A-Z_]+):\+/g)].map((match) => match[1])
    const listed = settings()
      .filter((setting) => !setting.compose)
      .map((setting) => setting.name)
    expect(passed.filter((name) => !IMAGE_SETS.includes(name as string)).sort()).toEqual([...listed].sort())
  })

  it('are all in the compose file’s example, which is written from the list', () => {
    expect(read('../../../deploy/compose/.env.example')).toBe(renderEnv({}, EXAMPLE_HEADER))
    // pnpm --filter gateway env-example writes it again
  })

  it('let a first-run .env start, and name everything wrong with a bad one at once', () => {
    expect(problemsOf(good)).toEqual([])
    expect(problemsOf({ ...good, PUBLIC_HOST: 'http://nas.local:8080' })).toEqual([])
    expect(problemsOf({ ...good, PUBLIC_HOST: 'gateway.example.test' })).toEqual([])
    // A first start has no settings at all, and that is fine
    expect(problemsOf({})).toEqual([])
    const bad = problemsOf({
      GATEWAY_MASTER_KEY: 'short',
      API_KEYS: 'owner:the-key-itself',
      PUBLIC_HOST: 'nas.local/app',
      ACCESS_TEAM: 'team',
      GATEWAY_LANGFUSE_PUBLIC_KEY: 'pk',
      GATEWAY_AI_GROUPING_PROVIDER: 'anthropic',
      GATEWAY_AI_GROUPING_DECIDER_PROTOCOL: 'grpc',
      DISCORD_WEBHOOK_URL: 'not a url',
    })
    expect(bad).toHaveLength(8)
    expect(bad.join('\n')).toMatch(/32 random bytes[\s\S]*go together[\s\S]*name:hash[\s\S]*isn’t an address/)
    expect(problemsOf({ ...good, GATEWAY_AI_BUILDS_PROVIDER: 'anthropic' })).toEqual([
      'GATEWAY_AI_BUILDS_PROVIDER is anthropic: it is one of openrouter, openai, local, custom.',
    ])
    // Cloudflare Access alone is a way in
    expect(problemsOf({ GATEWAY_MASTER_KEY: good.GATEWAY_MASTER_KEY, ACCESS_TEAM: 't', ACCESS_AUD: 'a' })).toEqual([])
  })

  it('GATEWAY_ADDRESS_HEADER is in the entrypoint, the compose example and the chart; a value that is no header name is named at start', () => {
    expect(read('../container/entrypoint.sh')).toContain('${GATEWAY_ADDRESS_HEADER:+')
    expect(read('../../../deploy/compose/.env.example')).toMatch(/^GATEWAY_ADDRESS_HEADER=$/m)
    expect(read('../../../deploy/compose/README.md')).toContain('GATEWAY_ADDRESS_HEADER=x-forwarded-for')
    expect(read('../../../deploy/helm/yardhand/values.yaml')).toMatch(/^addressHeader: ""$/m)
    expect(read('../../../deploy/helm/yardhand/templates/deployment.yaml')).toContain('name: GATEWAY_ADDRESS_HEADER')
    for (const header of ['x-forwarded-for', 'CF-Connecting-IP', 'x-real-ip'])
      expect(problemsOf({ ...good, GATEWAY_ADDRESS_HEADER: header })).toEqual([])
    for (const header of ['x-forwarded-for, cf-connecting-ip', 'X-Forwarded-For:', 'forwarded for'])
      expect(problemsOf({ ...good, GATEWAY_ADDRESS_HEADER: header })).toEqual([
        `GATEWAY_ADDRESS_HEADER (${header}) isn’t a header name: write the one header your proxy puts the caller’s address in (x-forwarded-for behind Caddy or nginx, cf-connecting-ip behind Cloudflare), or leave it empty when nothing is in front.`,
      ])
  })
})

describe('where a caller’s address is read', () => {
  it('from the header named, one hop from the right; else the connection itself', () => {
    expect(addressTrustOf({ GATEWAY_ADDRESS_HEADER: 'X-Forwarded-For' })).toEqual({
      header: 'x-forwarded-for',
      hops: 1,
    })
    expect(addressTrustOf({ GATEWAY_ADDRESS_HEADER: ' cf-connecting-ip ' })).toEqual({
      header: 'cf-connecting-ip',
      hops: 1,
    })
    expect(addressTrustOf({})).toBe('socket')
    expect(addressTrustOf({ GATEWAY_ADDRESS_HEADER: '' })).toBe('socket')
  })
})
