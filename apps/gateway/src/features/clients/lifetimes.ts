/** How long a key works, where a grant stands, and how the day it ended is written. */
import type { ClientRow } from './schema.js'

export const KEY_LIFETIMES = ['8h', '1d', '7d', '30d', 'never'] as const
export type KeyLifetime = (typeof KEY_LIFETIMES)[number]

/** What an end can be moved to: never a day or less, so a key is not ending soon the moment it was extended. */
export const EXTEND_LIFETIMES = ['7d', '30d', 'never'] as const

const HOUR_MS = 3_600_000
const LIFETIME_MS = { '8h': 8 * HOUR_MS, '1d': 24 * HOUR_MS, '7d': 7 * 24 * HOUR_MS, '30d': 30 * 24 * HOUR_MS } as const

/** When a key made or extended now stops working; null for `never` or no lifetime. */
export const expiryOf = (lifetime: KeyLifetime | undefined, now = new Date()): string | null =>
  !lifetime || lifetime === 'never' ? null : new Date(now.getTime() + LIFETIME_MS[lifetime]).toISOString()

/** How long before its end a grant counts as ending, and how long after it a person stays listed, in days. */
export const ENDING_DAYS = 3
export const ENDED_KEPT_DAYS = 30

const DAY_MS = 24 * HOUR_MS

/**
 * Where a grant stands: `ending` in its last three days, `ended` for 30 days after its end, `gone` after that or once
 * revoked. `createdAt` is enough to tell a short grant: one made for a day or less is never `ending`, and Extend sets
 * only 7 days, 30 days or never, so nothing is `ending` the moment the owner set it.
 */
export const standingOf = (
  row: Pick<ClientRow, 'createdAt' | 'expiresAt' | 'revokedAt'>,
  now = new Date(),
): 'live' | 'ending' | 'ended' | 'gone' => {
  if (row.revokedAt) return 'gone'
  if (!row.expiresAt) return 'live'
  const left = Date.parse(row.expiresAt) - now.getTime()
  if (left <= 0) return -left > ENDED_KEPT_DAYS * DAY_MS ? 'gone' : 'ended'
  const granted = Date.parse(row.expiresAt) - Date.parse(row.createdAt)
  return left <= ENDING_DAYS * DAY_MS && granted > ENDING_DAYS * DAY_MS ? 'ending' : 'live'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The UTC day of a time as `21 Dec 2026`, the same on every runtime. */
export const dayOf = (iso: string): string => {
  const at = new Date(iso)
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`
}
