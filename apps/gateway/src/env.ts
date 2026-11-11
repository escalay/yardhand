/**
 * Every setting the gateway takes from its environment, once: what each is for, which are needed, and what a first
 * `.env` looks like. The first-run script and `deploy/compose/.env.example` are written from this list, the
 * container's entrypoint passes exactly these names (a test holds the three together), and `problemsOf` checks a
 * real environment at start so a bad setting is named before anything listens. None of it is needed for a first
 * start: the instance makes its own keys and the owner claims it in the browser (`features/instance`).
 */
import { PROVIDERS } from './features/ai/config.js'
import type { Env } from './services.js'

type Setting = {
  name: string
  /** What it is for, as the .env says it; one line each. */
  about: string[]
  /** Read by Docker Compose to shape the stack; never passed into the gateway. */
  compose?: true
  /** What it is when left empty, shown as a commented line. */
  fallback?: string
}
type Section = { title: string; settings: Setting[] }

export const SECTIONS: Section[] = [
  {
    title: 'Keys. All optional: a new instance makes its own and keeps them in instance.json beside its data',
    settings: [
      {
        name: 'GATEWAY_MASTER_KEY',
        about: [
          'Seals every stored credential (32 random bytes, base64). Set here, it wins over the one in instance.json.',
          'Back it up: without it they are lost, and a backup restores only where the same one is set.',
        ],
      },
      {
        name: 'API_KEYS',
        about: [
          'More owners, as `name:<sha256 of the key>`. The owner who claimed the instance in the browser is kept in',
          'instance.json; the keys themselves are never stored.',
        ],
      },
      {
        name: 'OAUTH_SIGNING_KEY',
        about: ['Signs the tokens of agents that connect with OAuth (claude.ai connectors).'],
      },
    ],
  },
  {
    title: 'Where it is reached',
    settings: [
      {
        name: 'PUBLIC_HOST',
        about: [
          'The address people and agents use; the gateway hands it out in links and OAuth redirects.',
          'A bare name means HTTPS (gateway.example.test, with `--profile https` or your own proxy);',
          'write a plain-HTTP address whole: http://nas.local:8080.',
        ],
        fallback: 'http://localhost:<GATEWAY_PORT>',
      },
      {
        name: 'GATEWAY_PORT',
        compose: true,
        about: ['The port on this machine.'],
        fallback: '8080',
      },
      {
        name: 'GATEWAY_BIND',
        compose: true,
        about: [
          'Who can reach that port: 127.0.0.1 is this machine only (and Caddy, with `--profile https`);',
          '0.0.0.0 opens it to your network.',
        ],
        fallback: '127.0.0.1',
      },
      {
        name: 'GATEWAY_IMAGE',
        compose: true,
        about: ['The image to run. Empty: the release this compose file came with.'],
        fallback: 'ghcr.io/escalay/yardhand:<this release>',
      },
    ],
  },
  {
    title: 'Optional parts. Settings in the app shows which are on',
    settings: [
      { name: 'OPENROUTER_API_KEY', about: ['Tool search by meaning, not only by words (an OpenRouter key).'] },
      { name: 'DISCORD_WEBHOOK_URL', about: ['Posts a note when a third-party tool change waits for your review.'] },
      {
        name: 'COMPOSIO_API_KEY',
        about: ['A Composio CLI user key: a personal Composio connection reads its tool list with it.'],
      },
      {
        name: 'GATEWAY_LANGFUSE_URL',
        about: ['Call traces in Langfuse: metadata only, never arguments or results. Needs both keys.'],
        fallback: 'https://cloud.langfuse.com',
      },
      { name: 'GATEWAY_LANGFUSE_PUBLIC_KEY', about: [] },
      { name: 'GATEWAY_LANGFUSE_SECRET_KEY', about: [] },
    ],
  },
  {
    title: 'Smart grouping: a model sorts each connection’s tools into groups. Settings › AI can set all of this too',
    settings: [
      {
        name: 'GATEWAY_AI_GROUPING_PROVIDER',
        about: [`Where the models run: ${Object.keys(PROVIDERS).join(', ')}.`],
        fallback: 'openrouter',
      },
      { name: 'GATEWAY_AI_GROUPING_KEY', about: ['Its API key. Empty: groups come from naming rules.'] },
      {
        name: 'GATEWAY_AI_GROUPING_BASE_URL',
        about: ['For `local` and `custom`: the OpenAI-compatible API, ending /v1.'],
      },
      { name: 'GATEWAY_AI_GROUPING_WRITER_MODEL', about: ['The model that names groups.'] },
      { name: 'GATEWAY_AI_GROUPING_DECIDER_MODEL', about: ['The model that files each tool in a group.'] },
      {
        name: 'GATEWAY_AI_GROUPING_DECIDER_PROTOCOL',
        about: ['How the decider is asked: typesafe (TypeSafe’s decision API) or openai (a chat model).'],
      },
    ],
  },
  {
    title:
      'Usage telemetry: once a day, an anonymous report of ranges and yes/no answers. docs/telemetry.md lists it all',
    settings: [
      {
        name: 'GATEWAY_TELEMETRY',
        about: ['`off` sends nothing. Settings shows the exact report either way.'],
        fallback: 'on',
      },
      { name: 'DO_NOT_TRACK', about: ['`1` also switches it off, as in other tools.'] },
      {
        name: 'GATEWAY_TELEMETRY_URL',
        about: ['Where reports go: your own collector, for a fork or a fleet.'],
        fallback: 'https://pulse.escalay.space/v1/yardhand',
      },
    ],
  },
  {
    title: 'Sign-in by Cloudflare Access instead of the owner key (both, or neither)',
    settings: [
      { name: 'ACCESS_TEAM', about: ['Your Zero Trust team name.'] },
      { name: 'ACCESS_AUD', about: ['The Access application’s audience tag.'] },
    ],
  },
]

/** Names the image sets itself (Dockerfile) and the entrypoint also passes. */
export const IMAGE_SETS = [
  'PORT',
  'STATE_DIR',
  'WEB_DIR',
  'DATABASE_FILE',
  'GATEWAY_BUILD',
  'GATEWAY_SCRIPT',
  // How it was installed (compose, cloud-init, render, fly), set by each template for the usage report
  'GATEWAY_INSTALL',
  'NODE_ENV',
]

export const settings = () => SECTIONS.flatMap((section) => section.settings)

/** A `.env` with every setting explained; `values` fills some in, `header` goes on top. */
export const renderEnv = (values: Record<string, string> = {}, header: string[] = []) =>
  [
    ...header,
    ...SECTIONS.flatMap((section) => [
      '',
      `# ── ${section.title} ──`,
      ...section.settings.flatMap((setting) => [
        ...(setting.about.length ? [''] : []),
        ...setting.about.map((line) => `# ${line}`),
        ...(setting.fallback ? [`# Empty: ${setting.fallback}`] : []),
        `${setting.name}=${values[setting.name] ?? ''}`,
      ]),
    ]),
    '',
  ].join('\n')

export const EXAMPLE_HEADER = [
  '# Yardhand: every setting, explained. None is needed to start: `docker compose up -d`, then open the app',
  '# and follow the setup. Copy this file to .env for what you want to change. Keep .env private.',
]

/** What is wrong with an environment, each as a sentence that says how to put it right; empty when it can start. */
export const problemsOf = (env: Env) => {
  const problems: string[] = []
  // A missing master key is made for a new instance or refused by features/instance; a wrong one is named here
  const key = env.GATEWAY_MASTER_KEY
  if (key && Buffer.from(key, 'base64').length !== 32)
    problems.push('GATEWAY_MASTER_KEY must be 32 random bytes in base64 (openssl rand -base64 32).')
  if (Boolean(env.ACCESS_TEAM) !== Boolean(env.ACCESS_AUD))
    problems.push('ACCESS_TEAM and ACCESS_AUD go together: set both for Cloudflare Access sign-in, or neither.')
  for (const entry of (env.API_KEYS ?? '').split(',').filter(Boolean))
    if (!/^[^:\s]+:[0-9a-f]{64}$/.test(entry.trim()))
      problems.push(
        `API_KEYS has an entry that isn’t name:hash (${entry.trim().split(':')[0] || 'empty'}): it takes the hash the first-run script prints, never the key itself.`,
      )
  if (env.PUBLIC_HOST) {
    const whole = /^https?:\/\//.test(env.PUBLIC_HOST) ? env.PUBLIC_HOST : `https://${env.PUBLIC_HOST}`
    const url = URL.canParse(whole) ? new URL(whole) : null
    if (!url || url.pathname !== '/' || url.search || /\s/.test(env.PUBLIC_HOST))
      problems.push(
        `PUBLIC_HOST (${env.PUBLIC_HOST}) isn’t an address: a name like gateway.example.test, or http://nas.local:8080 written whole, without a path.`,
      )
  }
  if (Boolean(env.GATEWAY_LANGFUSE_PUBLIC_KEY) !== Boolean(env.GATEWAY_LANGFUSE_SECRET_KEY))
    problems.push('GATEWAY_LANGFUSE_PUBLIC_KEY and GATEWAY_LANGFUSE_SECRET_KEY go together: set both, or neither.')
  const provider = env.GATEWAY_AI_GROUPING_PROVIDER
  if (provider && !(provider in PROVIDERS))
    problems.push(`GATEWAY_AI_GROUPING_PROVIDER is ${provider}: it is one of ${Object.keys(PROVIDERS).join(', ')}.`)
  const protocol = env.GATEWAY_AI_GROUPING_DECIDER_PROTOCOL
  if (protocol && protocol !== 'typesafe' && protocol !== 'openai')
    problems.push(`GATEWAY_AI_GROUPING_DECIDER_PROTOCOL is ${protocol}: it is typesafe or openai.`)
  if (env.GATEWAY_TELEMETRY_URL && !URL.canParse(env.GATEWAY_TELEMETRY_URL))
    problems.push('GATEWAY_TELEMETRY_URL isn’t a URL: the address of a collector, or leave it empty.')
  if (env.DISCORD_WEBHOOK_URL && !URL.canParse(env.DISCORD_WEBHOOK_URL))
    problems.push('DISCORD_WEBHOOK_URL isn’t a URL: paste the webhook address Discord gives you, or leave it empty.')
  return problems
}
