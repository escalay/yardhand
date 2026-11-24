import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { addressTrustOf, EXAMPLE_HEADER, IMAGE_SETS, problemsOf, renderEnv, settings } from './env.js'
import { generateOAuthKey, hashApiKey, testDb } from './kit/index.js'
import { statedOriginOf } from './services.js'

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

describe('an odd PUBLIC_HOST', () => {
  /** A gateway with its sign-in on, started as server.ts starts one: its sign-in metadata's issuer. */
  const issuerOf = async (host: string) => {
    const app = await createApp({
      db: await testDb(),
      env: { ...good, OAUTH_SIGNING_KEY: await generateOAuthKey(), PUBLIC_HOST: host },
    })
    const metadata = await app.request('/.well-known/oauth-authorization-server')
    return ((await metadata.json()) as { issuer: string }).issuer
  }

  it('is written as URLs write it, and the gateway starts with sign-in at that origin', async () => {
    for (const [host, origin] of [
      ['GW.Example.COM', 'https://gw.example.com'],
      ['HTTPS://gw.example.com', 'https://gw.example.com'],
      ['https://gw.example.com:443', 'https://gw.example.com'],
      ['http://nas.example.test:80', 'http://nas.example.test'],
      ['http://nas.example.test:0080', 'http://nas.example.test'],
      ['https://gw.example.com:', 'https://gw.example.com'],
      ['bücher.example', 'https://xn--bcher-kva.example'],
      ['https://[2001:DB8:0:0::1]', 'https://[2001:db8::1]'],
      ['gw%2eexample.com', 'https://gw.example.com'],
      ['gw.example.com/', 'https://gw.example.com'],
    ] as const) {
      expect([host, problemsOf({ ...good, PUBLIC_HOST: host })]).toEqual([host, []])
      expect([host, statedOriginOf(host)]).toEqual([host, origin])
      expect([host, await issuerOf(host)]).toEqual([host, origin])
    }
  })

  it('with a user part, path, query or fragment is named at start, each in its own words', () => {
    const named = (host: string, part: string) =>
      `PUBLIC_HOST (${host}) isn’t an address: it has ${part}. Write the name alone, like gateway.example.test, or a whole address such as http://nas.local:8080.`
    for (const [host, part] of [
      ['user@gw.example.com', 'a user part (user@)'],
      ['https://user:secret@gw.example.com', 'a user part (user:secret@)'],
      ['https://@gw.example.com', 'a user part (@)'],
      ['nas.local/app', 'a path (/app)'],
      ['https://gw.example.com/%2e%2e/', 'a path (/%2e%2e/)'],
      ['https://gw.example.com\\app', 'a path (/app)'],
      ['gw.example.com?', 'a query (?)'],
      ['gw.example.com?x=1', 'a query (?x=1)'],
      ['gw.example.com#', 'a fragment (#)'],
      ['gw.example.com#top', 'a fragment (#top)'],
    ] as const)
      expect(problemsOf({ ...good, PUBLIC_HOST: host })).toEqual([named(host, part)])
  })

  it('that never starts is named at start, and nothing a check lets through stops the start', async () => {
    for (const host of ['https://', 'gw example.com', 'https://gw.example.com:99999', 'gw.example.com:port'])
      expect(problemsOf({ ...good, PUBLIC_HOST: host })).toEqual([
        `PUBLIC_HOST (${host}) isn’t an address: a name like gateway.example.test, or http://nas.local:8080 written whole, without a path.`,
      ])
    for (const host of ['gw.example.com.', 'http://[::1]:8080', 'https://0x7f.1', 'localhost'])
      if (!problemsOf({ ...good, PUBLIC_HOST: host }).length)
        expect([host, await issuerOf(host)]).toEqual([host, expect.stringMatching(/^https?:\/\//)])
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

  it('with no header named and an https address, from x-forwarded-for one hop from the right: a proxy is in front', () => {
    // The gateway listens on plain HTTP alone, so an https address is always a proxy's
    for (const host of ['gw.example.com', 'https://gw.example.com', 'GW.example.com'])
      expect([host, addressTrustOf({}, statedOriginOf(host))]).toEqual([host, { header: 'x-forwarded-for', hops: 1 }])
    expect(addressTrustOf({ GATEWAY_ADDRESS_HEADER: ' ' }, 'https://gw.example.com')).toEqual({
      header: 'x-forwarded-for',
      hops: 1,
    })
    // The header named always wins
    expect(addressTrustOf({ GATEWAY_ADDRESS_HEADER: 'CF-Connecting-IP' }, 'https://gw.example.com')).toEqual({
      header: 'cf-connecting-ip',
      hops: 1,
    })
    // Plain HTTP, this machine, or no address: the connection itself
    for (const host of ['http://nas.example.test:8080', 'http://localhost:8080', 'localhost', undefined])
      expect([host, addressTrustOf({}, statedOriginOf(host))]).toEqual([host, 'socket'])
  })
})
