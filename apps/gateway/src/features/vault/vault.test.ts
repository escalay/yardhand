import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { migrate, testDb } from '../../kit/index.js'
import { parseMasterKey, seal, unseal } from './crypto.js'
import { vaultRepo } from './repo.js'
import { VAULT_MIGRATIONS } from './schema.js'

const key = randomBytes(32)

describe('vault', () => {
  it('seals so only the same key opens, and tampering fails', () => {
    const sealed = seal(key, 'secret')
    expect(sealed).not.toContain('secret')
    expect(unseal(key, sealed)).toBe('secret')
    expect(() => unseal(randomBytes(32), sealed)).toThrow()
    const [v, iv, tag, body] = sealed.split('.')
    const flipped = `${body?.[0] === 'A' ? 'B' : 'A'}${body?.slice(1)}`
    expect(() => unseal(key, [v, iv, tag, flipped].join('.'))).toThrow()
  })

  it('refuses a master key that is missing or the wrong size', () => {
    expect(() => parseMasterKey(undefined)).toThrow(/not set/)
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/)
    expect(parseMasterKey(key.toString('base64'))).toHaveLength(32)
  })

  it('stores values sealed and replaces them in place', async () => {
    const db = await testDb()
    await migrate(db, 'vault', VAULT_MIGRATIONS)
    const vault = vaultRepo(db, key)
    await vault.put('upstream:cookbook', { type: 'bearer', token: 't1' })
    await vault.put('upstream:cookbook', { type: 'bearer', token: 't2' })
    expect(await vault.get('upstream:cookbook')).toEqual({ type: 'bearer', token: 't2' })
    await vault.remove('upstream:cookbook')
    expect(await vault.get('upstream:cookbook')).toBeUndefined()
  })
})
