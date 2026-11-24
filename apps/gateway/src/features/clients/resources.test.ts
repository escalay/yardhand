import { describe, expect, it } from 'vitest'
import { migrate, type TokenCaller, testDb } from '../../kit/index.js'
import { packsRepo } from '../packs/repo.js'
import { PACKS_MIGRATIONS } from '../packs/schema.js'
import { onGrantFor } from './grants.js'
import { withPackAddresses } from './pack-choice.js'
import { clientsRepo } from './repo.js'
import { accepts, classOf, issuesFor } from './resources.js'
import { CLIENTS_MIGRATIONS } from './schema.js'

const ORIGIN = 'http://localhost'
const rootOf = () => ORIGIN

const repos = async () => {
  const db = await testDb()
  await migrate(db, 'clients', CLIENTS_MIGRATIONS)
  await migrate(db, 'packs', PACKS_MIGRATIONS)
  return { clients: clientsRepo(db), packs: packsRepo(db) }
}

const callerFor = (resource: string, grant = 'g1'): TokenCaller => ({
  kind: 'agent',
  name: 'Sample',
  client: 'client_sample',
  grant,
  scopes: ['read', 'write'],
  owner: 'owner@example.test',
  resource,
})
const grantFor = (resource: string, grant = 'g1', scopes = ['read', 'write']) => ({
  kind: 'code' as const,
  grant,
  client: { id: 'client_sample', name: 'Sample' },
  approver: 'owner@example.test',
  scopes,
  resource,
})

/** What `accepts` answers for a request at `url`, run as the gateway serves it (a pack's address chosen up front). */
const acceptedAt = (judge: ReturnType<typeof accepts>, caller: TokenCaller, url: string) =>
  withPackAddresses(async (_request: Request) => new Response(JSON.stringify(await judge(caller, {} as never))))(
    new Request(url),
  ).then((answer) => answer.json() as Promise<true | string>)

describe('what a resource names', () => {
  it('the root, the legacy pack address and a pack’s own address; nothing else', () => {
    expect(classOf('')).toEqual({ kind: 'root' })
    expect(classOf('/mcp')).toEqual({ kind: 'root' })
    expect(classOf('/mcp/p/desk')).toEqual({ kind: 'root' })
    expect(classOf('/p/desk/mcp')).toEqual({ kind: 'pack', name: 'desk' })
  })

  // Every reader takes the same answer from classOf: none of these is a resource the gateway issues for or takes
  const ODD = [
    '/p/./desk/mcp',
    '/p/desk/./mcp',
    '/p/desk/../loud/mcp',
    '/p/%2edesk/mcp',
    '/p/desk%2e/mcp',
    '/p/desk/mcp?x=1',
    '/p/desk/mcp#top',
    '/mcp/p/x/p/loud/mcp',
    '/mcp/p/desk/mcp',
    '/P/desk/mcp',
    '/p/Desk/mcp',
    '/MCP',
    '/p/desk/mcp/',
    '/mcp/',
    '/',
    '/p/desk',
    '/p/desk/api',
    '/p/desk/mcp/x',
    '/p//mcp',
    '/p/-desk/mcp',
    `/p/${'a'.repeat(41)}/mcp`,
    '/api',
  ]

  it('one table of odd inputs, fed to every reader, which agree', async () => {
    const { clients, packs } = await repos()
    await packs.create({ name: 'desk', title: 'Desk', description: '' })
    const judge = accepts({ clients, packs }, rootOf)
    const grantOf = onGrantFor({ clients, packs })
    for (const [index, path] of ODD.entries()) {
      expect([path, classOf(path)]).toEqual([path, null])
      expect([path, issuesFor(path)]).toEqual([path, false])
      expect([path, await grantOf(grantFor(`${ORIGIN}${path}`, `g${index}`))]).toEqual([path, false])
      const judged = await acceptedAt(judge, callerFor(`${ORIGIN}${path}`, `g${index}`), `${ORIGIN}/p/desk/mcp`)
      expect([path, judged === true]).toEqual([path, false])
    }
    // A user part is no resource either, whatever its path says
    expect(await grantOf(grantFor(`http://someone@localhost/p/desk/mcp`, 'g-user'))).toBe(false)
    expect(await clients.list()).toEqual([])
  })
})

describe('whether a token is taken here', () => {
  const setUp = async () => {
    const all = await repos()
    const desk = await all.packs.create({ name: 'desk', title: 'Front desk', description: '' })
    await all.packs.create({ name: 'loud', title: 'Loud', description: '' })
    expect(await onGrantFor(all)(grantFor(`${ORIGIN}/p/desk/mcp`))).toBe(true)
    return { ...all, desk, judge: accepts(all, rootOf) }
  }

  it('a token for a pack’s address at that address only, judged by its row’s pack', async () => {
    const { judge } = await setUp()
    const caller = callerFor(`${ORIGIN}/p/desk/mcp`)
    expect(await acceptedAt(judge, caller, `${ORIGIN}/p/desk/mcp`)).toBe(true)
    expect(await acceptedAt(judge, caller, `${ORIGIN}/p/desk/api/tools`)).toBe(true)
    const elsewhere = 'This sign-in opens Front desk only: connect at http://localhost/p/desk/mcp.'
    for (const url of ['/mcp', '/api/tools', '/mcp/p/desk', '/p/loud/mcp', '/p/nowhere/mcp'])
      expect([url, await acceptedAt(judge, caller, `${ORIGIN}${url}`)]).toEqual([url, elsewhere])
  })

  it('compares no host: a pack token from one host name fits the same pack by another', async () => {
    const { judge } = await setUp()
    const caller = callerFor('http://127.0.0.1:8080/p/desk/mcp')
    expect(await acceptedAt(judge, caller, 'http://localhost:8080/p/desk/mcp')).toBe(true)
  })

  it('a pack token with no row, or a row that opens no pack, is refused naming nothing', async () => {
    const { clients, judge } = await setUp()
    const unknown = await acceptedAt(judge, callerFor(`${ORIGIN}/p/desk/mcp`, 'g-none'), `${ORIGIN}/p/desk/mcp`)
    expect(unknown).toBe('This sign-in is not known here: connect again.')
    await clients.create({ name: 'Sample', kind: 'oauth', scope: 'write', upstreams: 'all', grant: 'g-root' })
    const unlocked = await acceptedAt(judge, callerFor(`${ORIGIN}/p/desk/mcp`, 'g-root'), `${ORIGIN}/p/desk/mcp`)
    expect(unlocked).toBe('This sign-in is not known here: connect again.')
  })

  it('a root or aud-less token is taken everywhere', async () => {
    const { judge } = await setUp()
    const audless = callerFor('')
    delete audless.resource
    for (const caller of [audless, callerFor(ORIGIN), callerFor(`${ORIGIN}/mcp`), callerFor(`${ORIGIN}/mcp/p/desk`)])
      for (const url of ['/mcp', '/api/tools', '/p/desk/mcp', '/p/loud/api/tools', '/mcp/p/desk'])
        expect([caller.resource, url, await acceptedAt(judge, caller, `${ORIGIN}${url}`)]).toEqual([
          caller.resource,
          url,
          true,
        ])
  })
})

describe('the row an owner-approved sign-in at a pack’s address gets', () => {
  it('is locked to that pack, with the token’s scope, approved by the owner', async () => {
    const { clients, packs } = await repos()
    const desk = await packs.create({ name: 'desk', title: 'Desk', description: '' })
    expect(await onGrantFor({ clients, packs })(grantFor(`${ORIGIN}/p/desk/mcp`, 'g1', ['read']))).toBe(true)
    const row = await clients.byGrant('g1')
    expect(row).toMatchObject({ kind: 'oauth', scope: 'read', packId: desk, joinedBy: 'owner', allUpstreams: false })
    expect(await clients.packsOf({ id: row?.id ?? '', packId: null })).toEqual([desk])
  })

  it('at a name the pack used to have, is locked to the pack that name leads to', async () => {
    const { clients, packs } = await repos()
    const desk = await packs.create({ name: 'desk', title: 'Desk', description: '' })
    const pack = await packs.byId(desk)
    if (!pack) throw new Error('no pack')
    await packs.rename(pack, 'front', true)
    expect(await onGrantFor({ clients, packs })(grantFor(`${ORIGIN}/p/desk/mcp`))).toBe(true)
    expect((await clients.byGrant('g1'))?.packId).toBe(desk)
  })

  it('at a pack that does not exist, is not made', async () => {
    const { clients, packs } = await repos()
    expect(await onGrantFor({ clients, packs })(grantFor(`${ORIGIN}/p/desk/mcp`))).toBe(false)
    expect(await clients.list()).toEqual([])
  })

  it('at the root or the legacy pack address, is the root row it always was', async () => {
    const { clients, packs } = await repos()
    await packs.create({ name: 'desk', title: 'Desk', description: '' })
    for (const [grant, resource] of [
      ['g1', ORIGIN],
      ['g2', `${ORIGIN}/mcp`],
      ['g3', `${ORIGIN}/mcp/p/desk`],
    ] as const) {
      expect(await onGrantFor({ clients, packs })(grantFor(resource, grant))).toBe(true)
      expect(await clients.byGrant(grant)).toMatchObject({ scope: 'write', allUpstreams: true, packId: null })
    }
  })
})
