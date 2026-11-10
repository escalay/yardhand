/** Pure rules for the first-run setup: its steps, where the owner is, and what this instance needs looked at. */
import type { Overview, Schemas } from '@/api/client'

export const STEPS = [
  { id: 'instance', title: 'This instance', short: 'Check it runs as it should' },
  { id: 'server', title: 'A server', short: 'Connect the first one' },
  { id: 'agent', title: 'An agent', short: 'Give it a key and see it call' },
  { id: 'done', title: 'Ready', short: 'What to do next' },
] as const

export type StepId = (typeof STEPS)[number]['id']

export const isStep = (value: unknown): value is StepId => STEPS.some((step) => step.id === value)

/** Which steps are done, from the overview's own progress. */
export const doneOf = (setup: Overview['setup'], visited: StepId[]) => {
  const has = (id: string) => setup.steps.some((step) => step.id === id && step.done)
  return {
    instance: visited.includes('instance') || has('connect'),
    server: has('connect'),
    agent: has('first-call'),
    done: setup.complete,
  } satisfies Record<StepId, boolean>
}

/** The step to open on: the first that isn't done. */
export const firstOpen = (done: Record<StepId, boolean>): StepId => STEPS.find((step) => !done[step.id])?.id ?? 'done'

export type Check = { id: string; tone: 'ok' | 'warn'; title: string; body: string }

const isLocal = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)

/**
 * What the owner should know about this instance before agents use it: the address it hands out, whether keys travel
 * safely, where its master key lives, and its backups.
 */
export const checksOf = (
  system: Pick<Schemas['System'], 'publicOrigin' | 'keys' | 'features' | 'jobs'>,
  opened: string,
): Check[] => {
  const address: Check =
    system.publicOrigin === opened
      ? {
          id: 'address',
          tone: 'ok',
          title: 'Agents get the address you opened',
          body: `Links and sign-in redirects point to ${opened}.`,
        }
      : {
          id: 'address',
          tone: 'warn',
          title: 'Agents would get a different address',
          body: `You opened ${opened}, but Yardhand tells agents ${system.publicOrigin}. Set PUBLIC_HOST=${opened} in .env and restart it.`,
        }
  const https: Check =
    opened.startsWith('https:') || isLocal(opened)
      ? {
          id: 'https',
          tone: 'ok',
          title: opened.startsWith('https:') ? 'Keys travel over HTTPS' : 'Reachable from this machine only',
          body: opened.startsWith('https:')
            ? 'Every key an agent sends is encrypted on the way.'
            : 'Open it to your network or the internet when you are ready: the README has the four ways.',
        }
      : {
          id: 'https',
          tone: 'warn',
          title: 'Keys travel unencrypted',
          body: 'Plain HTTP is fine on your own network. Anywhere else, put HTTPS in front: the compose file has Caddy for it.',
        }
  const keys: Check =
    system.keys.masterKey === 'file'
      ? {
          id: 'keys',
          tone: 'warn',
          title: 'Copy the master key somewhere safe',
          body: 'It seals every credential you store and lives in instance.json beside the data. Without it, a backup can’t be opened: docker compose cp gateway:/state/instance.json ./',
        }
      : {
          id: 'keys',
          tone: 'ok',
          title: 'The master key is in your settings',
          body: 'GATEWAY_MASTER_KEY is set, so it lives wherever you keep your .env.',
        }
  const backup = system.jobs.find((job) => job.name === 'backup')
  const backups: Check = {
    id: 'backups',
    tone: 'ok',
    title: 'Backed up every day',
    body: backup?.at
      ? 'A copy of the database is made daily and the last seven are kept. Settings › Backups downloads one.'
      : 'The first copy is made within a few minutes, then daily; the last seven are kept.',
  }
  return [address, https, keys, backups]
}

/** "Claude Code on m3" style names, from where the agent runs. */
export const agentNameOf = (surface: string) => `${surface} on this machine`
