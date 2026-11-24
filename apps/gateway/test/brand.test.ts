/**
 * Yardhand's own brand, from `brand/` through the kit's brand part: the icons MCP clients show, the favicon, icons
 * and manifest at the root, and the browser app's own favicon and pages left as they are.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { hashApiKey, testDb } from '../src/kit/index.js'

const OWNER = 'owner-key-for-the-brand'
const MARK = readFileSync(new URL('../../web/public/favicon.svg', import.meta.url), 'utf8')
const APP_FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>the app</title></svg>'
// A built app with its own favicon and a page that names it, as apps/web's build has
const web = mkdtempSync(join(tmpdir(), 'yardhand-brand-web-'))
writeFileSync(
  join(web, 'index.html'),
  '<!doctype html><html><head><title>Yardhand</title><link rel="icon" href="/favicon.svg" type="image/svg+xml" /></head><body></body></html>',
)
writeFileSync(join(web, 'favicon.svg'), APP_FAVICON)
const app = await createApp({
  db: await testDb(),
  env: {
    API_KEYS: `owner:${hashApiKey(OWNER)}`,
    GATEWAY_MASTER_KEY: randomBytes(32).toString('base64'),
    WEB_DIR: web,
  },
})

type Init = { method?: string; body?: unknown; headers?: Record<string, string> }
const at = (key: string | null, path: string, init: Init = {}) =>
  app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      'content-type': 'application/json',
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })

type Icon = { src: string; mimeType?: string; sizes?: string[]; theme?: string }
type Greeting = { serverInfo: { name: string; title: string; icons?: Icon[] } }

/** The JSON-RPC result of an `initialize`, whether it came as JSON or as one event of a stream. */
const greeted = async (protocolVersion: string) => {
  const response = await at(OWNER, '/mcp', {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocolVersion },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '1' } },
    },
  })
  expect(response.status).toBe(200)
  const text = await response.text()
  const json = text.trimStart().startsWith('{') ? text : (text.match(/^data: (.*)$/m)?.[1] ?? 'null')
  return (JSON.parse(json) as { result: Greeting }).result
}

/** The bytes of a `data:` URL. */
const bytesOf = (src: string) => Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
/** A PNG's width and height, from its header. */
const sizeOf = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)]

/** Yardhand's icons in the order every client can use: the inline 96 PNG, this host's PNGs, the SVG last. */
const expectYardhandIcons = (icons: Icon[] | undefined) => {
  expect(icons?.map(({ mimeType, sizes }) => [mimeType, sizes])).toEqual([
    ['image/png', ['96x96']],
    ['image/png', ['192x192']],
    ['image/png', ['512x512']],
    ['image/svg+xml', ['any']],
  ])
  const [inline, ...rest] = icons ?? []
  expect(inline?.src).toMatch(/^data:image\/png;base64,/)
  const png = bytesOf(inline?.src ?? '')
  expect(png.subarray(0, 8)).toEqual(PNG)
  expect(sizeOf(png)).toEqual([96, 96])
  // Claude shows an inline icon only under 10 KB
  expect(png.length).toBeLessThan(10 * 1024)
  expect(rest.map((icon) => icon.src)).toEqual([
    'http://localhost/icon-192.png',
    'http://localhost/icon-512.png',
    'http://localhost/icon.svg',
  ])
}

beforeAll(async () => {
  const made = await at(OWNER, '/api/packs', {
    method: 'POST',
    body: { name: 'desk', title: 'Desk', description: 'Answers at the desk.' },
  })
  expect(made.status).toBe(201)
})

describe("Yardhand's brand", () => {
  it('greets an MCP client with its icons, a 2025 client and a 2026-07-28 one alike', async () => {
    for (const version of ['2025-06-18', '2026-07-28']) {
      const { serverInfo } = await greeted(version)
      expect(serverInfo).toMatchObject({ name: 'yardhand', title: 'Yardhand' })
      expectYardhandIcons(serverInfo.icons)
    }
  })

  it('puts them on the Server Card and the OpenAPI document', async () => {
    const card = (await (await at(null, '/mcp/server-card')).json()) as { icons?: Icon[] }
    expectYardhandIcons(card.icons)
    const openapi = (await (await at(null, '/openapi.json')).json()) as { info: Record<string, any> }
    expect(openapi.info['x-logo']).toMatchObject({ url: 'http://localhost/icon-512.png', altText: 'Yardhand' })
  })

  it('serves the favicon, icons and manifest at the root without a key', async () => {
    const favicon = await at(null, '/favicon.ico')
    expect([favicon.status, favicon.headers.get('content-type')]).toEqual([200, 'image/x-icon'])
    const ico = Buffer.from(await favicon.arrayBuffer())
    // An ICO of three images: 16, 32 and 48
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 3])
    for (const size of [192, 512]) {
      const icon = await at(null, `/icon-${size}.png`)
      expect(icon.status).toBe(200)
      expect(sizeOf(Buffer.from(await icon.arrayBuffer()))).toEqual([size, size])
    }
    // The mark is the app's own favicon, flat and square
    const svg = await at(null, '/icon.svg')
    expect([svg.status, await svg.text()]).toEqual([200, MARK])
    expect(readFileSync(new URL('../brand/icon.svg', import.meta.url), 'utf8')).toBe(MARK)
    const manifest = await at(null, '/site.webmanifest')
    expect(manifest.status).toBe(200)
    expect(await manifest.json()).toMatchObject({ name: 'Yardhand' })
    const again = await at(null, '/favicon.ico', { headers: { 'if-none-match': favicon.headers.get('etag') ?? '' } })
    expect(again.status).toBe(304)
  })

  it("leaves the app's own favicon and its pages' icon as they are", async () => {
    const favicon = await at(null, '/favicon.svg')
    expect([favicon.status, await favicon.text()]).toEqual([200, APP_FAVICON])
    const page = await (await at(null, '/app')).text()
    expect(page.match(/rel="icon"/g)).toHaveLength(1)
    expect(page).toContain('href="/favicon.svg"')
  })

  it("keeps its files at the root: a pack's address answers them as before, for a pack that exists and one that does not alike", async () => {
    // A pack's own favicon.ico and icon PNGs are open at its address (pack-icons.test.ts); the rest ask for a key
    for (const path of ['/icon.svg', '/apple-touch-icon.png', '/og.png', '/site.webmanifest']) {
      const real = await at(null, `/p/desk${path}`)
      const none = await at(null, `/p/nope${path}`)
      const [realBody, noneBody] = [(await real.json()) as any, (await none.json()) as any]
      expect([path, real.status, real.headers.get('content-type'), realBody.detail]).toEqual([
        path,
        none.status,
        none.headers.get('content-type'),
        noneBody.detail,
      ])
      expect(real.status).toBe(401)
    }
  })
})
