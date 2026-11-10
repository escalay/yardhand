/** Owner sessions: the only queries on them. */
import { createHash, randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import type { Db } from '../../kit/index.js'
import { sessions } from './schema.js'

export const SESSION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export const sessionsRepo = (db: Db) => ({
  /** A new session; answers the cookie's token, shown only to this browser. */
  open: async (userAgent: string | null) => {
    const token = randomBytes(32).toString('base64url')
    const now = new Date()
    await db.delete(sessions).where(lt(sessions.expiresAt, now.toISOString()))
    await db.insert(sessions).values({
      id: hashToken(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_DAYS * DAY_MS).toISOString(),
      userAgent: userAgent?.slice(0, 300) ?? null,
    })
    return token
  },
  valid: async (token: string) => {
    const row = (
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, hashToken(token)))
    )[0]
    return Boolean(row && row.expiresAt > new Date().toISOString())
  },
  close: (token: string) => db.delete(sessions).where(eq(sessions.id, hashToken(token))),
})

export type SessionsRepo = ReturnType<typeof sessionsRepo>
