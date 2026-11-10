/** Vault: sealed secrets. No routes: secrets go in through the features that own them and never come back out. */
import type { Feature } from '../index.js'
import { VAULT_MIGRATIONS } from './schema.js'

export const feature: Feature = {
  name: 'vault',
  tag: { name: 'Vault', description: 'Sealed secrets.' },
  migrations: VAULT_MIGRATIONS,
  register: () => {},
  tools: [],
}
