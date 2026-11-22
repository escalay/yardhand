import { describe, expect, it } from 'vitest'
import { hashApiKey } from '../../kit/index.js'
import { createPrincipals, endedNote, refusalOf } from './principals.js'
import type { ClientDraft } from './repo.js'

const now = new Date('2026-12-22T09:00:00.000Z')
const loud = { title: 'Loud' }
const live = { id: 'cl_1', name: 'Sam', revokedAt: null, expiresAt: '2027-01-20T09:00:00.000Z' }
const expired = { ...live, expiresAt: '2026-12-21T23:30:00.000Z' }
const revoked = { ...live, revokedAt: '2026-12-03T08:00:00.000Z' }

describe('what an ended key is told', () => {
  it('names the pack, the day it ended and whom to ask', () => {
    expect(refusalOf(expired, loud, now)).toBe(
      'Your access to Loud ended on 21 Dec 2026. Ask the owner for a new invite.',
    )
  })

  it('says when it expired, for a key without a pack', () => {
    expect(refusalOf(expired, null, now)).toBe(
      'This key expired on 21 Dec 2026: the owner can issue a new one in /app.',
    )
  })

  it('says it was revoked, with or without a pack', () => {
    const told = 'This key was revoked: the owner can issue a new one in /app.'
    expect(refusalOf(revoked, loud, now)).toBe(told)
    expect(refusalOf(revoked, null, now)).toBe(told)
    expect(refusalOf({ ...expired, revokedAt: revoked.revokedAt }, loud, now)).toBe(told)
  })

  it('is nothing while the key works', () => {
    expect(refusalOf(live, loud, now)).toBeNull()
    expect(refusalOf({ ...live, expiresAt: null }, null, now)).toBeNull()
  })
})

describe('what the owner is told, looking as an ended client', () => {
  it('names the person, the pack and the day, and how to extend', () => {
    expect(endedNote(expired, loud, now)).toBe(
      'Sam\'s access to Loud ended on 21 Dec 2026, so there is nothing to see as Sam: extend it with PATCH /api/clients/cl_1 {"expiresIn":"30d"}.',
    )
    expect(endedNote(expired, null, now)).toBe(
      'Sam\'s key expired on 21 Dec 2026, so there is nothing to see as Sam: extend it with PATCH /api/clients/cl_1 {"expiresIn":"30d"}.',
    )
  })

  it('says a revoked key needs a new one', () => {
    expect(endedNote(revoked, loud, now)).toBe(
      "Sam's key was revoked on 3 Dec 2026, so there is nothing to see as Sam: make a new key.",
    )
  })

  it('is nothing while the key works', () => {
    expect(endedNote(live, loud, now)).toBeNull()
  })
})

describe('a key that is issued', () => {
  it('is let in at once, and only its hash is kept', async () => {
    const keys = new Map<string, string>()
    const drafts: ClientDraft[] = []
    const clients = {
      create: async (draft: ClientDraft) => {
        drafts.push(draft)
        return 'cl_1'
      },
    }
    const principals = createPrincipals({ clients, packs: {}, catalog: {}, keys } as never)
    const issued = await principals.issue({ name: 'Sam', scope: 'read', upstreams: [], packIds: ['pk_1'] })
    expect(issued.id).toBe('cl_1')
    expect(issued.key).toMatch(/^gw_/)
    expect(keys.get(hashApiKey(issued.key))).toBe('client:cl_1')
    expect(drafts).toEqual([
      { name: 'Sam', scope: 'read', upstreams: [], packIds: ['pk_1'], kind: 'key', keyHash: hashApiKey(issued.key) },
    ])
    expect(JSON.stringify(drafts)).not.toContain(issued.key)
  })
})
