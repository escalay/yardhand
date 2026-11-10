import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EXAMPLE_HEADER, IMAGE_SETS, problemsOf, renderEnv, settings } from './env.js'
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
    // Cloudflare Access alone is a way in
    expect(problemsOf({ GATEWAY_MASTER_KEY: good.GATEWAY_MASTER_KEY, ACCESS_TEAM: 't', ACCESS_AUD: 'a' })).toEqual([])
  })
})
