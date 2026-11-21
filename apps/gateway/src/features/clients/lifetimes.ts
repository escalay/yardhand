/** How long a key works, and how the day it ended is written. */

export const KEY_LIFETIMES = ['8h', '1d', '7d', '30d', 'never'] as const
export type KeyLifetime = (typeof KEY_LIFETIMES)[number]

/** What an end can be moved to: never a day or less, so a key is not ending soon the moment it was extended. */
export const EXTEND_LIFETIMES = ['7d', '30d', 'never'] as const

const HOUR_MS = 3_600_000
const LIFETIME_MS = { '8h': 8 * HOUR_MS, '1d': 24 * HOUR_MS, '7d': 7 * 24 * HOUR_MS, '30d': 30 * 24 * HOUR_MS } as const

/** When a key made or extended now stops working; null for `never` or no lifetime. */
export const expiryOf = (lifetime: KeyLifetime | undefined, now = new Date()): string | null =>
  !lifetime || lifetime === 'never' ? null : new Date(now.getTime() + LIFETIME_MS[lifetime]).toISOString()

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The UTC day of a time as `21 Dec 2026`, the same on every runtime. */
export const dayOf = (iso: string): string => {
  const at = new Date(iso)
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`
}
