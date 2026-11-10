/** Writes the gateway's OpenAPI document to a file, from an empty in-memory gateway: the web app's types come from it. */
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createApp } from '../src/app.js'
import { hashApiKey, testDb } from '../src/kit/index.js'

const out = process.argv[2] ?? 'openapi.json'
const app = await createApp({
  db: await testDb(),
  env: { API_KEYS: `owner:${hashApiKey('write-openapi')}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
})
const doc = await (await app.request('/openapi.json')).json()
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`)
console.log(`OpenAPI → ${out} (${Object.keys(doc.paths).length} paths)`)
process.exit(0)
