import { describe, expect, it } from 'vitest'
import { migrate, testDb } from '../../kit/index.js'
import { onGrantFor } from './grants.js'
import { clientsRepo } from './repo.js'
import { CLIENTS_MIGRATIONS } from './schema.js'

const grantOf = (grant: string, name = 'Sample') => ({
  kind: 'claim' as const,
  grant,
  client: { id: `client_${grant}`, name },
  approver: 'owner@example.test',
  scopes: ['read', 'write'],
})

describe('the row a new sign-in gets', () => {
  const repo = async () => {
    const db = await testDb()
    await migrate(db, 'clients', CLIENTS_MIGRATIONS)
    return clientsRepo(db)
  }

  it('is made with the grant: write, every upstream, the app’s client id, no name to be found by', async () => {
    const clients = await repo()
    expect(await onGrantFor({ clients })(grantOf('g1'))).toBe(true)
    const row = await clients.byGrant('g1')
    expect(row).toMatchObject({
      name: 'Sample',
      kind: 'oauth',
      oauthName: null,
      oauthClientId: 'client_g1',
      scope: 'write',
      allUpstreams: true,
    })
    expect(await clients.grantsOf(row?.id ?? '')).toEqual(['g1'])
  })

  it('a grant the start mapped already keeps its row and is not withdrawn', async () => {
    const clients = await repo()
    const id = await clients.create({
      name: 'Sample',
      kind: 'oauth',
      oauthName: 'Sample',
      scope: 'read',
      upstreams: [],
    })
    await clients.mapGrant('g1', id, true)
    expect(await onGrantFor({ clients })(grantOf('g1'))).toBe(true)
    expect((await clients.list()).map((row) => row.id)).toEqual([id])
  })

  it('a row that fails to be made leaves its grant free for the next try', async () => {
    const clients = await repo()
    await clients.create({ name: 'Sample', kind: 'oauth', oauthName: 'Sample', scope: 'write', upstreams: 'all' })
    const draft = { name: 'Sample', kind: 'oauth' as const, scope: 'write' as const, upstreams: 'all' as const }
    await expect(clients.create({ ...draft, oauthName: 'Sample', grant: 'g1' })).rejects.toThrow()
    expect(await clients.byGrant('g1')).toBeUndefined()
    const id = await clients.create({ ...draft, grant: 'g1' })
    expect((await clients.byGrant('g1'))?.id).toBe(id)
  })
})
