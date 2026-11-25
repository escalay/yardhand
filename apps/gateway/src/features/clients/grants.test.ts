import { describe, expect, it } from 'vitest'
import { migrate, testDb } from '../../kit/index.js'
import { packsRepo } from '../packs/repo.js'
import { PACKS_MIGRATIONS } from '../packs/schema.js'
import { onGrantFor, onRevokeFor } from './grants.js'
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
    await migrate(db, 'packs', PACKS_MIGRATIONS)
    return { clients: clientsRepo(db), packs: packsRepo(db) }
  }

  it('is made with the grant: write, every upstream, the app’s client id, no name to be found by', async () => {
    const { clients, packs } = await repo()
    expect(await onGrantFor({ clients, packs })(grantOf('g1'))).toBe(true)
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
    const { clients, packs } = await repo()
    const id = await clients.create({
      name: 'Sample',
      kind: 'oauth',
      oauthName: 'Sample',
      scope: 'read',
      upstreams: [],
    })
    await clients.mapGrant('g1', id, true)
    expect(await onGrantFor({ clients, packs })(grantOf('g1'))).toBe(true)
    expect((await clients.list()).map((row) => row.id)).toEqual([id])
  })

  it('an app that gives a blank name is shown as an unnamed app', async () => {
    const { clients, packs } = await repo()
    await onGrantFor({ clients, packs })(grantOf('g1', ''))
    await onGrantFor({ clients, packs })(grantOf('g2', '  '))
    expect((await clients.list()).map((row) => row.name)).toEqual(['Unnamed app', 'Unnamed app'])
  })

  it('a row that fails to be made leaves its grant free for the next try', async () => {
    const { clients } = await repo()
    await clients.create({ name: 'Sample', kind: 'oauth', oauthName: 'Sample', scope: 'write', upstreams: 'all' })
    const draft = { name: 'Sample', kind: 'oauth' as const, scope: 'write' as const, upstreams: 'all' as const }
    await expect(clients.create({ ...draft, oauthName: 'Sample', grant: 'g1' })).rejects.toThrow()
    expect(await clients.byGrant('g1')).toBeUndefined()
    const id = await clients.create({ ...draft, grant: 'g1' })
    expect((await clients.byGrant('g1'))?.id).toBe(id)
  })
})

describe('a sign-in the kit ends', () => {
  const repo = async () => {
    const db = await testDb()
    await migrate(db, 'clients', CLIENTS_MIGRATIONS)
    await migrate(db, 'packs', PACKS_MIGRATIONS)
    return { clients: clientsRepo(db), packs: packsRepo(db) }
  }

  it('withdrawn before its first token: the row made for it is gone, with its grant, upstreams, packs and pins', async () => {
    const { clients, packs } = await repo()
    const packId = await packs.create({ name: 'desk', title: 'Desk', description: '' })
    await onGrantFor({ clients, packs })({ ...grantOf('g1'), resource: 'http://localhost/p/desk/mcp' })
    const row = await clients.byGrant('g1')
    expect(row?.packId).toBe(packId)
    await onRevokeFor({ clients })({ grant: 'g1', client: 'client_g1', reason: 'withdrawn' })
    expect(await clients.byGrant('g1')).toBeUndefined()
    expect(await clients.get(row?.id ?? '')).toBeUndefined()
    expect(await clients.ofPack(packId)).toEqual([])
    expect(await clients.grantsOf(row?.id ?? '')).toEqual([])
  })

  it('withdrawn: a row that stands for other sign-ins too only lets go of this one', async () => {
    const { clients, packs } = await repo()
    await onGrantFor({ clients, packs })(grantOf('g1'))
    const id = (await clients.byGrant('g1'))?.id ?? ''
    await clients.mapGrant('g2', id)
    await onRevokeFor({ clients })({ grant: 'g2', reason: 'withdrawn' })
    expect(await clients.grantsOf(id)).toEqual(['g1'])
    expect((await clients.get(id))?.revokedAt).toBeNull()
  })

  it('withdrawn: a row mapped from before 0.6.4 stays as it is', async () => {
    const { clients } = await repo()
    const id = await clients.create({
      name: 'Sample',
      kind: 'oauth',
      oauthName: 'Sample',
      scope: 'read',
      upstreams: [],
    })
    await clients.mapGrant('g1', id, true)
    await onRevokeFor({ clients })({ grant: 'g1', reason: 'withdrawn' })
    expect(await clients.grantsOf(id)).toEqual(['g1'])
    expect(await clients.get(id)).toBeDefined()
  })

  it('a grant no row stands for, a client with no grant, or told twice: nothing changes, nothing throws', async () => {
    const { clients, packs } = await repo()
    await onGrantFor({ clients, packs })(grantOf('g1'))
    const before = await clients.list()
    const onRevoke = onRevokeFor({ clients })
    await onRevoke({ grant: 'unknown', reason: 'withdrawn' })
    await onRevoke({ client: 'client_g1', reason: 'client_revoked' })
    await onRevoke({ grant: 'g1', reason: 'revoked' })
    await onRevoke({ grant: 'g1', reason: 'replayed' })
    expect(await clients.list()).toEqual(before)
    await onRevoke({ grant: 'g1', reason: 'withdrawn' })
    await onRevoke({ grant: 'g1', reason: 'withdrawn' })
    expect(await clients.list()).toEqual([])
  })
})
