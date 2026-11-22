import { describe, expect, it } from 'vitest'
import { migrate, testDb } from '../../kit/index.js'
import { packsRepo } from './repo.js'
import { PACKS_MIGRATIONS } from './schema.js'

const repoWith = async () => {
  const db = await testDb()
  await migrate(db, 'packs', PACKS_MIGRATIONS)
  const packs = packsRepo(db)
  const id = await packs.create({ name: 'desk', title: 'Front desk', description: 'Greets people.' })
  return { packs, id }
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
