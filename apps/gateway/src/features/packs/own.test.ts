import { describe, expect, it } from 'vitest'
import { migrate, testDb } from '../../kit/index.js'
import { holdsOwn, OWNER, type Principal, packScopeFrom } from '../clients/principals.js'
import { createPackDocs } from './own.js'
import { packsRepo } from './repo.js'
import { PACKS_MIGRATIONS } from './schema.js'
import { SKILL_DOC } from './skill.js'

const HELLO = `---
title: Say hello
description: Greets a guest by name.
arguments:
  - name: guest
    description: Who to greet.
    required: true
  - name: door
---

1. Greet {{guest}} at {{door}}, for {{desk}}.
`
const draft = (body: string) => ({ body, basedOn: {}, source: 'owner' as const })

const setup = async () => {
  const db = await testDb()
  await migrate(db, 'packs', PACKS_MIGRATIONS)
  const packs = packsRepo(db)
  const make = async (name: string, title: string) => {
    const id = await packs.create({ name, title, description: `${title}: greets people.` })
    await packs.setVariables(id, [{ name: 'desk', value: `the ${name} desk` }])
    await packs.saveDoc(id, 'playbook', 'say-hello', draft(HELLO.replace('Say hello', `Say hello from ${title}`)))
    await packs.saveDoc(id, 'skill', SKILL_DOC, draft(`## What it is for\n\nGreeting, for {{desk}}.`))
    return id
  }
  /** A caller locked to this pack, as `packScopeFrom` builds the lock from what is stored. */
  const keyOf = async (name: string): Promise<Principal> => {
    const pack = await packs.get(name)
    if (!pack) throw new Error(`no pack ${name}`)
    return { ...OWNER, id: `key-${name}`, owner: false, pack: packScopeFrom(pack, await packs.contentsOf(pack)) }
  }
  return { packs, make, keyOf, docs: createPackDocs({ packs }) }
}

describe('a pack’s documents, as its keys are served them', () => {
  it('gives a pack’s key its playbooks, read from their front matter, and its skill', async () => {
    const { make, keyOf, docs } = await setup()
    await make('desk', 'Desk')
    const key = await keyOf('desk')
    expect(key.pack).toMatchObject({ ownPlaybooks: new Set(['say-hello']), skill: 'skill://desk/SKILL.md' })
    expect(holdsOwn(key, 'say-hello')).toBe(true)
    const [listed] = await docs.playbooks(key)
    expect(listed).toMatchObject({
      name: 'say-hello',
      title: 'Say hello from Desk',
      description: 'Greets a guest by name.',
      arguments: [
        { name: 'guest', description: 'Who to greet.', required: true },
        { name: 'door', description: null, required: false },
      ],
      versionId: expect.stringMatching(/^pdv_/),
    })
    expect(await docs.playbook(key, 'say-hello')).toEqual(listed)
    const skill = await docs.skill(key)
    expect(skill).toMatchObject({ uri: 'skill://desk/SKILL.md', path: 'desk', versionId: expect.any(String) })
    expect(skill?.text).toContain('# Working with Desk\n\n## What it is for\n\nGreeting, for the desk desk.')
  })

  it('fills a playbook with the arguments given, then the pack’s variables', async () => {
    const { make, keyOf, docs } = await setup()
    await make('desk', 'Desk')
    const key = await keyOf('desk')
    const playbook = await docs.playbook(key, 'say-hello')
    if (!playbook) throw new Error('no playbook')
    // An argument left out is filled with nothing; a value filled in is never read for placeholders again
    expect(await docs.render(key, playbook, { guest: '{{desk}}' })).toBe('1. Greet {{desk}} at , for the desk desk.\n')
    // An argument wins over a variable of the same name
    expect(await docs.render(key, playbook, { guest: 'Sam', door: 'the side door' })).toBe(
      '1. Greet Sam at the side door, for the desk desk.\n',
    )
  })

  it('answers only what the caller’s own lock names', async () => {
    const { packs, make, keyOf, docs } = await setup()
    await make('desk', 'Desk')
    const loud = await make('loud', 'Loud')
    await packs.saveDoc(loud, 'playbook', 'only-loud', draft('1. Shout.'))
    const desk = await keyOf('desk')
    expect((await docs.playbooks(desk)).map((playbook) => playbook.title)).toEqual(['Say hello from Desk'])
    expect(await docs.playbook(desk, 'only-loud')).toBeUndefined()
    expect((await docs.skill(desk))?.text).not.toContain('Loud')
    // Outside a pack there is nothing to read, for the owner too
    expect([await docs.playbooks(OWNER), await docs.playbook(OWNER, 'say-hello'), await docs.skill(OWNER)]).toEqual([
      [],
      undefined,
      undefined,
    ])
  })

  it('reads the lock before it looks a pack up, so a removed pack’s key never reads a pack named removed', async () => {
    const { make, keyOf, docs } = await setup()
    await make('removed', 'Removed')
    expect((await docs.playbooks(await keyOf('removed'))).length).toBe(1)
    // What a key whose pack is gone is given (`fromRow` in principals.ts)
    const gone: Principal = {
      ...OWNER,
      owner: false,
      pack: packScopeFrom(
        { id: 'pk_gone', name: 'removed', title: 'a removed pack', description: '' },
        { tools: [], variables: [], playbooks: [], manuals: [], docs: [] },
      ),
    }
    expect([await docs.playbooks(gone), await docs.playbook(gone, 'say-hello'), await docs.skill(gone)]).toEqual([
      [],
      undefined,
      undefined,
    ])
  })

  it('drops a document the lock names once the pack no longer has it', async () => {
    const { packs, make, keyOf, docs } = await setup()
    const id = await make('desk', 'Desk')
    const key = await keyOf('desk')
    await packs.removeDoc(id, 'playbook', 'say-hello')
    await packs.removeDoc(id, 'skill', SKILL_DOC)
    expect([await docs.playbooks(key), await docs.playbook(key, 'say-hello'), await docs.skill(key)]).toEqual([
      [],
      undefined,
      undefined,
    ])
  })

  it('serves a playbook whose front matter can’t be read under its name, with no arguments', async () => {
    const { packs, make, keyOf, docs } = await setup()
    const id = await make('desk', 'Desk')
    await packs.saveDoc(id, 'playbook', 'say-hello', draft('---\ntitle: [unclosed\n---\n\n1. Greet them.\n'))
    const playbook = await docs.playbook(await keyOf('desk'), 'say-hello')
    expect(playbook).toMatchObject({ title: 'Say hello', description: '', arguments: [], body: '1. Greet them.\n' })
  })
})
