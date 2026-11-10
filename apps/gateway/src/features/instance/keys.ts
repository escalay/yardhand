/**
 * An instance's own keys, for a start with no `.env`: the master key, the OAuth signing key and, once the owner has
 * claimed the instance, the hash of the owner key. They live in `<state>/instance.json` (readable by the server only),
 * beside the database but outside it, so a restore never changes who owns the instance. A setting in the
 * environment always wins over the file.
 *
 * Keys are only ever made for a new instance: a database that already holds sealed secrets without a master key is
 * refused, never given a fresh key that couldn't open them.
 */
import { randomBytes, randomInt } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { generateOAuthKey } from '../../kit/index.js'

export type InstanceFile = { masterKey?: string; signingKey?: string; ownerHash?: string }

export const INSTANCE_FILE = 'instance.json'
/** No 0/O, 1/I/L: a code read off a terminal and typed into a browser. */
const CODE_LETTERS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

export const fileOf = (stateDir: string) => join(stateDir, INSTANCE_FILE)

export const readInstance = (stateDir: string): InstanceFile => {
  const path = fileOf(stateDir)
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as InstanceFile) : {}
}

/** Writes the file whole, then moves it into place, so a crash never leaves half a key. */
export const writeInstance = (stateDir: string, value: InstanceFile) => {
  const path = fileOf(stateDir)
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
  chmodSync(path, 0o600)
}

/** "7F3K-92QD": eight characters that can't be misread. */
export const setupCode = () =>
  Array.from(
    { length: 8 },
    (_, index) => `${index === 4 ? '-' : ''}${CODE_LETTERS[randomInt(CODE_LETTERS.length)]}`,
  ).join('')

/** Does this database already hold sealed secrets (so it needs the master key it was made with)? */
const holdsSecrets = (databaseFile: string) => {
  if (!existsSync(databaseFile)) return false
  const db = new DatabaseSync(databaseFile, { readOnly: true })
  try {
    const table = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'secrets'").get()
    return Boolean(table && db.prepare('select 1 from secrets limit 1').get())
  } finally {
    db.close()
  }
}

type Env = Record<string, string | undefined>

/**
 * The environment the server runs with: the file's keys where the environment has none, keys made for a new
 * instance, and the owner's hash in `API_KEYS`. `problems` says why it can't start; `open` is true while nobody
 * owns the instance yet.
 */
export const resolveInstance = async (env: Env, stateDir: string, databaseFile: string) => {
  const file = readInstance(stateDir)
  const problems: string[] = []
  const next = { ...file }
  if (env.GATEWAY_MASTER_KEY && file.masterKey && env.GATEWAY_MASTER_KEY !== file.masterKey)
    problems.push(
      `GATEWAY_MASTER_KEY in the environment differs from the one in ${INSTANCE_FILE} beside the database. Keep the one the stored credentials were sealed with and remove the other.`,
    )
  if (!env.GATEWAY_MASTER_KEY && !file.masterKey) {
    if (holdsSecrets(databaseFile))
      problems.push(
        'The database holds sealed credentials but there is no GATEWAY_MASTER_KEY to open them. Put back the .env (or instance.json) it was made with; a new key would lock them away for good.',
      )
    else next.masterKey = randomBytes(32).toString('base64')
  }
  if (!env.OAUTH_SIGNING_KEY && !file.signingKey) next.signingKey = await generateOAuthKey()
  if (JSON.stringify(next) !== JSON.stringify(file) && !problems.length) writeInstance(stateDir, next)
  const owner = next.ownerHash ? `owner:${next.ownerHash}` : ''
  const resolved: Env = {
    ...env,
    GATEWAY_MASTER_KEY: env.GATEWAY_MASTER_KEY || next.masterKey,
    OAUTH_SIGNING_KEY: env.OAUTH_SIGNING_KEY || next.signingKey,
    API_KEYS: [env.API_KEYS, owner].filter(Boolean).join(','),
  }
  const open = !resolved.API_KEYS && !(env.ACCESS_TEAM && env.ACCESS_AUD)
  return {
    env: resolved,
    problems,
    open,
    /** Where the master key lives, for Settings: the environment, or the file beside the data. */
    masterKeyFrom: (env.GATEWAY_MASTER_KEY ? 'env' : 'file') as 'env' | 'file',
    /** Records the owner: only the hash, and only once. */
    claim: (ownerHash: string) => writeInstance(stateDir, { ...readInstance(stateDir), ownerHash }),
  }
}

/** Forgets the owner, so the next start opens setup again (the way back from a lost owner key). */
export const resetOwner = (stateDir: string) => {
  const { ownerHash: _, ...rest } = readInstance(stateDir)
  writeInstance(stateDir, rest)
}

/** The box the server prints while it waits to be claimed. */
export const setupBanner = (origin: string, code: string) => {
  const lines = [
    'Yardhand is ready to be set up',
    '',
    `Open        ${origin}/app`,
    `Setup code  ${code}`,
    '',
    'The code works once. A restart makes a new one.',
  ]
  const width = Math.max(...lines.map((line) => line.length)) + 4
  return [
    `┌${'─'.repeat(width)}┐`,
    ...lines.map((line) => `│  ${line.padEnd(width - 4)}  │`),
    `└${'─'.repeat(width)}┘`,
  ].join('\n')
}
