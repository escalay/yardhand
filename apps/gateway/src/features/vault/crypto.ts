/** AES-256-GCM sealing: `v1.<iv>.<tag>.<ciphertext>`, each part base64url. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** The 32-byte master key from its base64 form; refuses anything else so a typo never seals with a weak key. */
export const parseMasterKey = (value: string | undefined) => {
  if (!value) throw new Error('GATEWAY_MASTER_KEY is not set: 32 random bytes in base64 (openssl rand -base64 32)')
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32) throw new Error(`GATEWAY_MASTER_KEY must decode to 32 bytes, not ${key.length}`)
  return key
}

export const seal = (key: Buffer, plain: string) => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv, cipher.getAuthTag(), body]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.')
}

export const unseal = (key: Buffer, sealed: string) => {
  const [version, iv, tag, body] = sealed.split('.')
  if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('Not a sealed v1 secret')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
}
