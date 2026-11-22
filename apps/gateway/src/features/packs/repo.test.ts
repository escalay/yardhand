import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { migrate, testDb } from '../../kit/index.js'
import { packsRepo } from './repo.js'
import { PACKS_MIGRATIONS, packDocs } from './schema.js'

const repoWith = async () => {
  const db = await testDb()
  await migrate(db, 'packs', PACKS_MIGRATIONS)
  const packs = packsRepo(db)
  const id = await packs.create({ name: 'desk', title: 'Front desk', description: 'Greets people.' })
  return { db, packs, id }
}
/** A read that starts some turns of the loop after a save did, so it lands between the save's statements. */
const readAfter = async <T>(turns: number, read: () => Promise<T>) => {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve()
  return read()
}

describe('setVariables', () => {
  it('replaces the set in the order given, with new values and without the names left out', async () => {
    const { packs, id } = await repoWith()
    await packs.setVariables(id, [
      { name: 'desk', value: 'the desk', description: 'Who greets.' },
      { name: 'days', value: 7 },
      { name: 'loud', value: true },
    ])
    await packs.setVariables(id, [
      { name: 'days', value: 14, description: 'How far back.' },
      { name: 'desk', value: 'the boss' },
    ])
    expect(await packs.variablesOf(id)).toEqual([
      { packId: id, name: 'days', value: '14', description: 'How far back.', position: 0 },
      { packId: id, name: 'desk', value: '"the boss"', description: null, position: 1 },
    ])
    await packs.setVariables(id, [])
    expect(await packs.variablesOf(id)).toEqual([])
  })

  it('never leaves a read without a variable the pack keeps, however the two interleave', async () => {
    const { packs, id } = await repoWith()
    const kept = [
      { name: 'desk', value: 'the desk' },
      { name: 'days', value: 7 },
    ]
    await packs.setVariables(id, [...kept, { name: 'gone', value: 'x' }])
    const save = packs.setVariables(id, kept)
    const seen = await Promise.all(
      Array.from({ length: 60 }, (_, turns) =>
        readAfter(turns, async () => (await packs.variablesOf(id)).map((row) => row.name)),
      ),
    )
    await save
    for (const names of seen) expect(names).toEqual(expect.arrayContaining(['desk', 'days']))
    expect((await packs.variablesOf(id)).map((row) => row.name)).toEqual(['desk', 'days'])
  })
})

describe('a pack’s documents', () => {
  const hello = { body: 'Greet them.', basedOn: { greet_from_desk: 'v1' }, source: 'owner' as const }

  it('keeps every text a playbook had, and serves the newest', async () => {
    const { packs, id } = await repoWith()
    const first = await packs.saveDoc(id, 'playbook', 'say-hello', hello)
    const second = await packs.saveDoc(id, 'playbook', 'say-hello', { ...hello, body: 'Greet them twice.' })
    expect([first.added, second.added]).toEqual([true, true])
    expect(await packs.doc(id, 'playbook', 'say-hello')).toMatchObject({
      kind: 'playbook',
      name: 'say-hello',
      body: 'Greet them twice.',
      basedOn: { greet_from_desk: 'v1' },
      versionId: second.versionId,
      source: 'owner',
    })
    expect((await packs.docVersions(id, 'playbook', 'say-hello')).map((version) => version.id)).toEqual([
      second.versionId,
      first.versionId,
    ])
    expect((await packs.docVersion(id, 'playbook', 'say-hello', first.versionId))?.body).toBe('Greet them.')
  })

  it('adds no version for the same text, and notes the tool versions it now stands on', async () => {
    const { packs, id } = await repoWith()
    const first = await packs.saveDoc(id, 'playbook', 'say-hello', hello)
    const again = await packs.saveDoc(id, 'playbook', 'say-hello', { ...hello, basedOn: { greet_from_desk: 'v2' } })
    expect(again).toEqual({ versionId: first.versionId, added: false })
    expect(await packs.docVersions(id, 'playbook', 'say-hello')).toHaveLength(1)
    expect((await packs.doc(id, 'playbook', 'say-hello'))?.basedOn).toEqual({ greet_from_desk: 'v2' })
  })

  it('makes a new document only under a name it has none of, however saves interleave', async () => {
    const { packs, id } = await repoWith()
    const made = await Promise.all(
      Array.from({ length: 6 }, (_, turn) =>
        packs.createDoc(id, 'playbook', 'say-hello', { ...hello, body: `Greet ${turn}.` }),
      ),
    )
    const [won, ...more] = made.filter(Boolean)
    expect(more).toEqual([])
    const versions = await packs.docVersions(id, 'playbook', 'say-hello')
    expect(versions.map((version) => version.id)).toEqual([won])
    expect((await packs.doc(id, 'playbook', 'say-hello'))?.versionId).toBe(won)
    // A name it already has is taken too
    expect(await packs.createDoc(id, 'playbook', 'say-hello', hello)).toBeUndefined()
  })

  it('gives each new document its own place, however saves interleave', async () => {
    const { db, packs, id } = await repoWith()
    await Promise.all(['one', 'two', 'three', 'four'].map((name) => packs.saveDoc(id, 'playbook', name, hello)))
    const rows = await db.select({ position: packDocs.position }).from(packDocs).where(eq(packDocs.packId, id))
    expect(new Set(rows.map((row) => row.position)).size).toBe(4)
  })

  it('lists a pack’s documents in the order they were first saved, each pack its own', async () => {
    const { packs, id } = await repoWith()
    const other = await packs.create({ name: 'loud', title: 'Loud', description: '' })
    await packs.saveDoc(id, 'playbook', 'say-hello', hello)
    await packs.saveDoc(id, 'skill', 'SKILL', { ...hello, body: '## Gotchas' })
    await packs.saveDoc(id, 'playbook', 'say-bye', hello)
    await packs.saveDoc(id, 'playbook', 'say-hello', { ...hello, body: 'Greet them again.' })
    await packs.saveDoc(other, 'playbook', 'say-hello', { ...hello, body: 'Shout hello.' })
    expect((await packs.docsOf(id)).map((doc) => [doc.kind, doc.name])).toEqual([
      ['playbook', 'say-hello'],
      ['skill', 'SKILL'],
      ['playbook', 'say-bye'],
    ])
    const [desk] = await packs.list()
    expect(desk && (await packs.contentsOf(desk)).docs).toHaveLength(3)
    expect((await packs.allDocs()).map(({ pack, doc }) => [pack.name, doc.name, doc.body])).toEqual([
      ['desk', 'say-hello', 'Greet them again.'],
      ['desk', 'SKILL', '## Gotchas'],
      ['desk', 'say-bye', 'Greet them.'],
      ['loud', 'say-hello', 'Shout hello.'],
    ])
  })

  it('reads a version only as the document it belongs to', async () => {
    const { packs, id } = await repoWith()
    const other = await packs.create({ name: 'loud', title: 'Loud', description: '' })
    const { versionId } = await packs.saveDoc(id, 'playbook', 'say-hello', hello)
    await packs.saveDoc(id, 'playbook', 'say-bye', hello)
    expect(await packs.docVersion(id, 'playbook', 'say-bye', versionId)).toBeUndefined()
    expect(await packs.docVersion(id, 'skill', 'say-hello', versionId)).toBeUndefined()
    expect(await packs.docVersion(other, 'playbook', 'say-hello', versionId)).toBeUndefined()
  })

  it('removes a document with its versions, and all of them with the pack', async () => {
    const { packs, id } = await repoWith()
    const { versionId } = await packs.saveDoc(id, 'playbook', 'say-hello', hello)
    await packs.saveDoc(id, 'skill', 'SKILL', hello)
    expect(await packs.removeDoc(id, 'playbook', 'say-hello')).toBe(true)
    expect(await packs.removeDoc(id, 'playbook', 'say-hello')).toBe(false)
    expect(await packs.docVersion(id, 'playbook', 'say-hello', versionId)).toBeUndefined()
    await packs.remove(id)
    expect(await packs.allDocs()).toEqual([])
    expect(await packs.docVersions(id, 'skill', 'SKILL')).toEqual([])
  })
})
