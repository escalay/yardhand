import { describe, expect, it } from 'vitest'
import { endingAccess } from './ending.js'

const now = new Date('2026-12-19T12:30:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const at = (days: number) => new Date(now.getTime() + days * DAY_MS).toISOString()

const packs = [
  { id: 'pk_loud', name: 'loud', title: 'Loud' },
  { id: 'pk_desk', name: 'desk', title: 'Desk' },
]
const client = (id: string, name: string, packId: string | null, made: number, ends: number | null) => ({
  id,
  name,
  packId,
  createdAt: at(made),
  expiresAt: ends === null ? null : at(ends),
  revokedAt: null as string | null,
})
const ending = (rows: ReturnType<typeof client>[]) =>
  endingAccess({ clients: { list: async () => rows }, packs: { list: async () => packs } } as never, now)

describe('whose access is ending', () => {
  it('names each person in their last three days with their pack, soonest first', async () => {
    const rows = [
      client('cl_sam', 'Sam', 'pk_loud', -27, 2.5),
      client('cl_ada', 'Ada', 'pk_desk', -29, 0.5),
      client('cl_far', 'Far', 'pk_loud', -1, 29),
      client('cl_forever', 'Forever', 'pk_loud', -40, null),
    ]
    expect(await ending(rows)).toEqual([
      { id: 'cl_ada', name: 'Ada', pack: { name: 'desk', title: 'Desk' }, expiresAt: at(0.5) },
      { id: 'cl_sam', name: 'Sam', pack: { name: 'loud', title: 'Loud' }, expiresAt: at(2.5) },
    ])
  })

  it('leaves out a key made for three days or less, one that ended, one revoked and one outside a pack', async () => {
    const revoked = { ...client('cl_gone', 'Gone', 'pk_loud', -27, 2), revokedAt: at(-1) }
    const rows = [
      client('cl_session', 'Session', 'pk_loud', 0, 8 / 24),
      client('cl_ended', 'Ended', 'pk_loud', -30, -0.5),
      revoked,
      client('cl_agent', 'Agent', null, -27, 2),
    ]
    expect(await ending(rows)).toEqual([])
  })

  it('skips a key whose pack was removed, so one such key breaks nothing', async () => {
    const rows = [client('cl_lost', 'Lost', 'pk_removed', -27, 2), client('cl_sam', 'Sam', 'pk_loud', -27, 2)]
    expect((await ending(rows)).map((entry) => entry.id)).toEqual(['cl_sam'])
  })
})
