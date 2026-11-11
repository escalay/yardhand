/** Starts Yardhand: opens the database, builds the app, listens on PORT. */
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { problemsOf } from './env.js'
import { applyPending } from './features/backups/restore.js'
import { resolveInstance, setupBanner, setupCode } from './features/instance/keys.js'
import { prepareUpgrade } from './features/instance/upgrade.js'
import { createTelemetry } from './features/telemetry/index.js'
import { createUpdates } from './features/updates/index.js'
import { startJobs } from './jobs.js'
import { openDb } from './kit/index.js'
import type { Env } from './services.js'
import { VERSION } from './version.js'

// One upstream's stray rejection (an SDK transport, a timer) must not take every client down with it
process.on('unhandledRejection', (reason) =>
  console.error(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`),
)

const stateDir = process.env.STATE_DIR ?? '.state'
mkdirSync(stateDir, { recursive: true })
// A node:sqlite file by default; to move to Turso or D1, open its Drizzle database here and pass it in
const databaseFile = (process.env.DATABASE_FILE ?? `file:${join(stateDir, 'state.sqlite')}`).replace(/^file:/, '')
// A restore staged before the last stop takes the database's place before anything opens it
if (applyPending(stateDir, databaseFile)) console.log('restored the database from the staged backup')
// Keys missing from the environment come from instance.json beside the data, made there for a new instance
const instance = await resolveInstance(process.env, stateDir, databaseFile)
const env = instance.env as Env
// A bad setting is named here, all at once, before anything opens or listens
// A newer version backs the data up before migrating it; an older one doesn't touch data a newer one wrote
const upgrade = prepareUpgrade(stateDir, databaseFile, VERSION)
const problems = [...instance.problems, ...problemsOf(env), ...(upgrade.problem ? [upgrade.problem] : [])]
if (problems.length) {
  console.error(['The gateway can’t start:', ...problems.map((problem) => `  • ${problem}`)].join('\n'))
  // Long enough that a supervisor restarting it doesn't flood the log
  await new Promise((resolve) => setTimeout(resolve, 5000))
  process.exit(78)
}
if (upgrade.undone)
  console.log(
    `Yardhand ${upgrade.undone} was started on this data and never came up: the data from before it was put back (what it left is in backups/failed-${upgrade.undone}.sqlite)`,
  )
if (upgrade.backup) console.log(`backed up the data before upgrading to ${VERSION}: ${upgrade.backup}`)
const db = await openDb(`file:${databaseFile}`)
const code = instance.open ? setupCode() : null
let claimed = !instance.open
const claim: typeof instance.claim = (...given) => {
  claimed = true
  return instance.claim(...given)
}
const app = await createApp({ db, env, ...(code ? { unclaimed: { code, claim } } : {}) })
const telemetry = createTelemetry(app.services, () => ({
  claimed,
  install: process.env.GATEWAY_INSTALL,
  arch: process.arch,
  databaseBytes: statSync(databaseFile, { throwIfNoEntry: false })?.size ?? 0,
}))
app.services.telemetry.current = telemetry
const updates = createUpdates(app.services, stateDir)
app.services.updates.current = updates
startJobs(app.services, { stateDir, webhookUrl: process.env.DISCORD_WEBHOOK_URL, telemetry, updates })
// A restore ends the process; Docker (restart: unless-stopped) or the dev watcher starts it again
app.services.restart.current = () => process.exit(0)
// Live sync: listen to every upstream that announces its changes
void app.services.watcher.start()
const port = Number(process.env.PORT ?? 4400)
serve({ fetch: app.fetch, hostname: '0.0.0.0', port }, (info) => {
  upgrade.stamp()
  console.log(`Yardhand → ${app.services.publicOrigin}/app (listening on ${info.port}; /docs, /llms.txt, /mcp)`)
  if (code) console.log(setupBanner(app.services.publicOrigin, code))
  // Said at every start, and a day before the first report: what is sent and how to stop it
  void telemetry
    .view()
    .then(({ off, firstAt }) =>
      console.log(
        off
          ? `Usage telemetry is off (${off}).`
          : `Usage telemetry: one anonymous report a day (ranges and yes/no answers, no names or addresses), ${new Date(firstAt) > new Date() ? `the first after ${firstAt}` : 'sent daily'}. GATEWAY_TELEMETRY=off stops it; Settings shows the report; docs/telemetry.md lists every field.`,
      ),
    )
  // Said at every start: that it asks for the newest version, and how to stop it
  void updates
    .view()
    .then(({ check, checkUrl }) =>
      console.log(
        check
          ? `Update check: once a day it asks ${checkUrl} for the newest version (no id, no report). Settings › Updates switches it off; GATEWAY_UPDATE_CHECK=off starts a new instance with it off.`
          : 'Update check is off (Settings › Updates switches it on).',
      ),
    )
})
