/**
 * The answers the kit keeps for an `Idempotency-Key`, sealed with the master key. The kit keeps a whole answer for a
 * day, and a daily backup copies it: one that shows a key once (a new client, a share, the claim) or sets a session
 * cookie would otherwise lie readable in the database. The headers and the body are sealed together; the request's
 * hash and the status stay as they are, for the kit to check a replay by.
 */
import { type Db, dbGuardStore, type GuardStore, type StoredAnswer } from '../../kit/index.js'
import { seal, unseal } from './crypto.js'
import { keptAnswersRepo } from './repo.js'

type Held = Pick<StoredAnswer, 'headers' | 'body'>

/** A sealed value starts `v1.`; base64, which the kit writes a body in, has no dot. */
const isSealed = (answer: StoredAnswer) => answer.body.startsWith('v1.')

const sealed = (key: Buffer, answer: StoredAnswer): StoredAnswer =>
  isSealed(answer)
    ? answer
    : { ...answer, headers: [], body: seal(key, JSON.stringify({ headers: answer.headers, body: answer.body })) }

const opened = (key: Buffer, answer: StoredAnswer): StoredAnswer =>
  isSealed(answer) ? { ...answer, ...(JSON.parse(unseal(key, answer.body)) as Held) } : answer

/**
 * The guards' store in the database, keeping every answer sealed. What an earlier version kept as it was is sealed
 * where it lies, before the first request.
 */
export const sealedGuardStore = async (db: Db, key: Buffer): Promise<GuardStore> => {
  const store = await dbGuardStore(db)
  const kept = keptAnswersRepo(db)
  for (const row of await kept.list()) {
    const answer = JSON.parse(row.value) as StoredAnswer
    if (!isSealed(answer)) await kept.replace(row.id, JSON.stringify(sealed(key, answer)))
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
