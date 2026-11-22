/** The vault: JSON values sealed at rest; the only place secrets are read or written. */
import { and, eq, ne } from 'drizzle-orm'
import { type Db, kitGuards } from '../../kit/index.js'
import { seal, unseal } from './crypto.js'
import { secrets } from './schema.js'

export const vaultRepo = (db: Db, key: Buffer) => ({
  put: async (id: string, value: unknown) => {
    const row = { id, sealed: seal(key, JSON.stringify(value)), updatedAt: new Date().toISOString() }
    await db
      .insert(secrets)
      .values(row)
      .onConflictDoUpdate({ target: secrets.id, set: { sealed: row.sealed, updatedAt: row.updatedAt } })
  },
  get: async <T>(id: string) => {
    const row = (await db.select().from(secrets).where(eq(secrets.id, id)))[0]
    return row ? (JSON.parse(unseal(key, row.sealed)) as T) : undefined
  },
  remove: (id: string) => db.delete(secrets).where(eq(secrets.id, id)),
  /** Does this gateway's master key open a sealed value (one from another database, say)? */
  opens: (sealed: string) => {
    try {
      unseal(key, sealed)
      return true
    } catch {
      return false
    }
  },
})

export type Vault = ReturnType<typeof vaultRepo>

/** The answers the kit keeps for an `Idempotency-Key` (`kit_guards`), to seal the ones kept before they were. */
export const keptAnswersRepo = (db: Db) => {
  const answer = (id: string) => and(eq(kitGuards.kind, 'key'), eq(kitGuards.id, id))
  return {
    list: () =>
      db
        .select({ id: kitGuards.id, value: kitGuards.value })
        .from(kitGuards)
        .where(and(eq(kitGuards.kind, 'key'), ne(kitGuards.value, ''))),
    replace: (id: string, value: string) => db.update(kitGuards).set({ value }).where(answer(id)),
  }
}
