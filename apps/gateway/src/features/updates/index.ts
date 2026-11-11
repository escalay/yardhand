/**
 * Updates (docs/updates.md): once a day this instance asks for the newest version with one plain request (no id, no
 * report; it works with telemetry off), and shows it to the owner with its release notes. The gateway never updates
 * itself and never reaches Docker: asked to update, it writes a request into `<state>/updates` and an updater outside
 * carries it out, checking the release's signature first, so the version asked for is only a hint. Where no updater
 * runs, a deploy hook of the platform can be called instead.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from '@hono/zod-openapi'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import { VERSION } from '../../version.js'
import { requireOwner } from '../clients/principals.js'
import type { Feature } from '../index.js'
import { compareVersions } from '../instance/upgrade.js'
import { PATH, routes, StatusSchema, TAG } from './routes.js'

export const DEFAULT_URL = 'https://pulse.escalay.space/v1/yardhand/latest'
const RELEASES = 'https://github.com/escalay/yardhand/releases'
export const DOCS = 'https://github.com/escalay/yardhand/blob/main/docs/updates.md'
/** What updates a Docker Compose install by hand: the new release's compose file, then its image. */
export const MANUAL = `curl -fsSL -o docker-compose.yml ${RELEASES}/latest/download/docker-compose.yml\ndocker compose pull && docker compose up -d`
const CHECK_TIMEOUT_MS = 5000
const HOOK_TIMEOUT_MS = 10_000
const PRESENT_MS = 90_000
const SHOWN = 20
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/

type UpdatesEnv = {
  GATEWAY_UPDATE_CHECK?: string
  GATEWAY_AUTO_UPDATE?: string
  GATEWAY_UPDATE_URL?: string
  GATEWAY_UPDATE_HOOK?: string
  GATEWAY_UPDATE_HOOK_TOKEN?: string
}
type Vault = {
  get: <T>(name: string) => Promise<T | undefined>
  put: (name: string, value: unknown) => Promise<unknown>
}
type Switches = { check?: boolean; auto?: boolean }
type Latest = { version: string; checkedAt: string }
export type Run = z.infer<typeof StatusSchema>

const SWITCHES = 'updates:settings'
const LATEST = 'updates:latest'
const UpdaterSchema = z.object({ at: z.string(), version: z.string() })

const off = (value: string | undefined) => /^(off|false|0|no)$/i.test(value ?? '')
const on = (value: string | undefined) => /^(on|true|1|yes)$/i.test(value ?? '')
const said = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A JSON file the updater wrote, or null when it is missing, half-written or not what it should be. */
const readJson = <T>(path: string, schema: z.ZodType<T>): T | null => {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The runs in `history.jsonl`, newest first; a line that isn't a run is skipped. */
const readHistory = (path: string): Run[] => {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .flatMap((line) => {
      try {
        const parsed = StatusSchema.safeParse(JSON.parse(line))
        return parsed.success ? [parsed.data] : []
      } catch {
        return []
      }
    })
    .reverse()
}

export const createUpdates = (
  services: { env: unknown; vault: Vault },
  stateDir: string,
  fetchImpl: typeof fetch = fetch,
  current: string = VERSION,
) => {
  const { vault } = services
  const env = services.env as UpdatesEnv
  const url = env.GATEWAY_UPDATE_URL || DEFAULT_URL
  const dir = join(stateDir, 'updates')
  const hook = env.GATEWAY_UPDATE_HOOK || null

  const switches = async () => {
    const kept = (await vault.get<Switches>(SWITCHES)) ?? {}
    return { check: kept.check ?? !off(env.GATEWAY_UPDATE_CHECK), auto: kept.auto ?? on(env.GATEWAY_AUTO_UPDATE) }
  }
  const updater = (now: Date) => {
    const beat = readJson(join(dir, 'updater.json'), UpdaterSchema)
    const age = beat ? now.getTime() - new Date(beat.at).getTime() : Number.NaN
    return { present: age < PRESENT_MS, version: beat?.version ?? null }
  }
  const status = () => readJson(join(dir, 'status.json'), StatusSchema)
  const newerThanCurrent = (version: string) => compareVersions(version, current) > 0

  const view = async (now = new Date()) => {
    const [{ check, auto }, latest] = [await switches(), (await vault.get<Latest>(LATEST)) ?? null]
    const beside = updater(now)
    return {
      current,
      latest: latest && { ...latest, notes: `${RELEASES}/tag/v${latest.version}` },
      newer: Boolean(latest && newerThanCurrent(latest.version)),
      check,
      auto,
      checkUrl: url,
      updater: beside,
      hook: Boolean(hook),
      how: (beside.present ? 'updater' : hook ? 'hook' : 'manual') as 'updater' | 'hook' | 'manual',
      manual: MANUAL,
      docs: DOCS,
      status: status(),
      history: readHistory(join(dir, 'history.jsonl')).slice(0, SHOWN),
    }
  }

  /** Asks for the newest version and keeps the answer; throws saying what came back when it isn't a version. */
  const check = async (now = new Date()) => {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      credentials: 'omit',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    const answer = (await response.json().catch(() => null)) as { latest?: unknown } | null
    const version = answer?.latest
    if (typeof version !== 'string' || !VERSION_SHAPE.test(version))
      throw new Error(`${url} didn’t name a version (it must answer {"latest":"1.2.3"})`)
    const latest: Latest = { version, checkedAt: now.toISOString() }
    await vault.put(LATEST, latest)
    return latest
  }

  /** Leaves the request where the updater looks, whole or not at all. */
  const leave = (version: string, now: Date) => {
    mkdirSync(dir, { recursive: true })
    const request = { id: randomUUID(), version, at: now.toISOString() }
    const draft = join(dir, `request.${request.id}.tmp`)
    writeFileSync(draft, `${JSON.stringify(request)}\n`)
    renameSync(draft, join(dir, 'request.json'))
    return request
  }

  const callHook = async (target: string) => {
    const token = env.GATEWAY_UPDATE_HOOK_TOKEN
    // The address can carry a secret of its own (a Render deploy hook), so neither it nor the token is ever said
    const response = await fetchImpl(target, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
    }).catch(() => null)
    if (!response?.ok)
      throw new ProblemError('upstream', {
        detail: `The deploy hook (GATEWAY_UPDATE_HOOK) ${response ? `answered ${response.status}` : 'couldn’t be reached'}, so no update started. Check the hook where this instance is hosted, then try again.`,
        headers: { 'Retry-After': '30' },
      })
  }

  return {
    view,
    check,
    /** The daily job: says what it did, in a sentence Settings shows. */
    daily: async (now = new Date()) => {
      const { check: checks, auto } = await switches()
      if (!checks) return 'Off: the daily check is switched off (Settings › Updates)'
      const { version } = await check(now)
      if (!newerThanCurrent(version)) return `Up to date: ${current} is the newest`
      const found = `${version} is out (this is ${current})`
      if (!auto) return found
      if (!updater(now).present) return `${found}; automatic updates need the updater, which isn’t running`
      if (status()?.state === 'working') return `${found}; an update is already under way`
      const tried = readHistory(join(dir, 'history.jsonl')).find(
        (run) => run.to === version && (run.state === 'failed' || run.state === 'refused'),
      )
      if (tried)
        return `${found}; not tried again by itself, since the last update to it ${tried.state === 'failed' ? 'failed' : 'was refused'}`
      leave(version, now)
      return `${found}; asked the updater to install it`
    },
    change: async (given: Switches, now = new Date()) => {
      if (given.auto && !updater(now).present)
        throw new ProblemError('conflict', {
          detail: `Automatic updates need the updater container beside this gateway, and none has written in the last 90 seconds. It ships with the Docker Compose install (GATEWAY_UPDATER=0 removes it): ${DOCS}`,
        })
      const kept = (await vault.get<Switches>(SWITCHES)) ?? {}
      await vault.put(SWITCHES, {
        ...kept,
        ...(given.check === undefined ? {} : { check: given.check }),
        ...(given.auto === undefined ? {} : { auto: given.auto }),
      })
    },
    /** Asks for an update to a version, or to the newest known; throws the 409 that says why not. */
    request: async (wanted: string | undefined, now = new Date()) => {
      const version = wanted ?? (await vault.get<Latest>(LATEST))?.version
      if (!version)
        throw new ProblemError('conflict', {
          detail: `No newer version is known yet. Check first (POST ${PATH}/check), or name one as {"version":"1.2.3"}.`,
        })
      if (!VERSION_SHAPE.test(version))
        throw new ProblemError('conflict', {
          detail: `${version.slice(0, 40)} isn’t a version: write it as 1.2.3, without a v.`,
        })
      if (!newerThanCurrent(version))
        throw new ProblemError('conflict', {
          detail: `This is Yardhand ${current}, and ${version} isn’t newer: there is nothing to update to. An older version is never installed over newer data.`,
        })
      const last = status()
      if (last?.state === 'working')
        throw new ProblemError('conflict', {
          detail: `An update to ${last.to} is already under way (${last.step}). Follow it at GET ${PATH}.`,
        })
      if (updater(now).present) return void leave(version, now)
      if (hook) return callHook(hook)
      throw new ProblemError('conflict', {
        detail: `Nothing here can carry out an update: no updater container runs beside this gateway and no deploy hook is set. Update by hand where it runs: ${MANUAL.replace('\n', ' && ')} (${DOCS}).`,
      })
    },
  }
}

export type Updates = ReturnType<typeof createUpdates>

export const feature: Feature = {
  name: 'updates',
  tag: { name: TAG, description: 'The version running, the newest one, and moving to it.' },
  migrations: [],
  register: (app, { updates }) => {
    const present = () => {
      if (!updates.current)
        throw new ProblemError('conflict', {
          detail:
            'This gateway runs without updates (a test process), so there is no newer version to show and nothing to ask for.',
        })
      return updates.current
    }
    const body = async (c: Parameters<typeof originOf>[0], current: Updates) => ({
      ...(await current.view()),
      _links: linksOf(originOf(c), {
        self: PATH,
        check: `${PATH}/check`,
        requests: `${PATH}/requests`,
        system: '/api/system',
      }),
    })
    app.openapi(routes.updates, async (c) => {
      requireOwner(c)
      return c.json(await body(c, present()), 200)
    })
    app.openapi(routes.check, async (c) => {
      requireOwner(c)
      const current = present()
      await current.check().catch((error) => {
        throw new ProblemError('upstream', {
          detail: `The check for a newer version failed: ${said(error)}. The daily check tries again by itself; GATEWAY_UPDATE_URL sets another address.`,
          headers: { 'Retry-After': '30' },
        })
      })
      return c.json(await body(c, current), 200)
    })
    app.openapi(routes.change, async (c) => {
      requireOwner(c)
      const current = present()
      await current.change(c.req.valid('json'))
      return c.json(await body(c, current), 200)
    })
    app.openapi(routes.request, async (c) => {
      requireOwner(c)
      const current = present()
      const given = (await c.req.json().catch(() => ({}))) as { version?: unknown }
      await current.request(typeof given.version === 'string' ? given.version : undefined)
      return c.json(await body(c, current), 202)
    })
  },
  tools: [],
}
