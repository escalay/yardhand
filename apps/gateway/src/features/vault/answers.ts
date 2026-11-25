/**
 * The answers the kit keeps for an `Idempotency-Key`, sealed with the master key. An answer that showed a secret once
 * (a new client, a share, the claim, a session cookie) keeps only what a retry is told (`showOnce`); any other is kept
 * whole for a day, and a daily backup copies it, so its headers and body are sealed together. The request's hash, the
 * status and the version stay as they are, for the kit to check a replay by.
 */
import { type Db, dbGuardStore, type GuardStore, type ReplayedAnswer, type StoredAnswer } from '../../kit/index.js'
import { seal, unseal } from './crypto.js'
import { keptAnswersRepo } from './repo.js'

type Held = Pick<ReplayedAnswer, 'headers' | 'body'>

/** A sealed value starts `v1.`; base64, which the kit writes a body in, has no dot. */
const isSealed = (answer: ReplayedAnswer) => answer.body.startsWith('v1.')

const sealed = (key: Buffer, answer: StoredAnswer): StoredAnswer =>
  'shownOnce' in answer || isSealed(answer)
    ? answer
    : { ...answer, headers: [], body: seal(key, JSON.stringify({ headers: answer.headers, body: answer.body })) }

const opened = (key: Buffer, answer: StoredAnswer): StoredAnswer =>
  'shownOnce' in answer || !isSealed(answer) ? answer : { ...answer, ...(JSON.parse(unseal(key, answer.body)) as Held) }

/**
 * The guards' store in the database, keeping every answer sealed. At start, an answer an earlier version kept (no
 * `version`, which the kit never replays) is dropped, and one kept whole as it was is sealed where it lies.
 */
export const sealedGuardStore = async (db: Db, key: Buffer): Promise<GuardStore> => {
  const store = await dbGuardStore(db)
  const kept = keptAnswersRepo(db)
  for (const row of await kept.list()) {
    const answer = JSON.parse(row.value) as Partial<StoredAnswer>
    if (answer.version !== 2) await kept.drop(row.id)
    else if (!('shownOnce' in answer) && !isSealed(answer as ReplayedAnswer))
      await kept.replace(row.id, JSON.stringify(sealed(key, answer as StoredAnswer)))
  }
  return {
    ...store,
    claim: async (id, lockMs, now) => {
      const hit = await store.claim(id, lockMs, now)
      return hit && hit !== 'running' ? opened(key, hit) : hit
    },
    save: (id, answer, expiresAt) => store.save(id, sealed(key, answer), expiresAt),
  }
}
