/**
 * A pack's icon: the monogram every name gets, an icon the owner uploads or a colour they pick, the four files open at
 * the pack's address (alike for a pack with no icon of its own and a name no pack has), the pack's MCP greeting and
 * OpenAPI document, and the icon carried through a config export and import.
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import sharp from 'sharp'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { monogramOf, PALETTE, renderedMonogram, renderedUpload } from '../src/features/packs/icon.js'
import { hashApiKey, ProblemError, testDb } from '../src/kit/index.js'
import { sizeless } from './fixtures/svg.js'

const OWNER = 'owner-key-for-pack-icons'
const PNG = 'image/png'
const SVG = 'image/svg+xml'
const FILES = ['icon-96.png', 'icon-192.png', 'icon-512.png', 'favicon.ico'] as const
const made = async () =>
  createApp({
    db: await testDb(),
    env: { API_KEYS: `owner:${hashApiKey(OWNER)}`, GATEWAY_MASTER_KEY: randomBytes(32).toString('base64') },
  })
// Uploads are limited to ten an hour: each part that uploads has a gateway of its own
const app = await made()
const uploads = await made()
const fetches = await made()
const renames = await made()

type Init = { method?: string; body?: unknown; headers?: Record<string, string>; raw?: Uint8Array }
const at = async (gateway: typeof app, key: string | null, path: string, init: Init = {}) => {
  const response = await gateway.request(path, {
    method: init.method ?? 'GET',
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    ...(init.raw
      ? { body: new Blob([init.raw as Uint8Array<ArrayBuffer>]) }
      : init.body === undefined
        ? {}
        : { body: JSON.stringify(init.body) }),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  const json = (() => {
    try {
      return JSON.parse(bytes.toString('utf8')) as any
    } catch {
      return null
    }
  })()
  return { status: response.status, headers: response.headers, bytes, json }
}
const owner = (path: string, init?: Init) => at(app, OWNER, path, init)
const upload = (gateway: typeof app, name: string, bytes: Uint8Array, type = 'image/png', key = OWNER) =>
  at(gateway, key, `/api/packs/${name}/icon`, { method: 'PUT', raw: bytes, headers: { 'content-type': type } })
const makePack = async (gateway: typeof app, name: string, title: string) => {
  const answer = await at(gateway, OWNER, '/api/packs', { method: 'POST', body: { name, title } })
  expect(answer.status).toBe(201)
  return answer.json
}
const square = (size: number, colour: string) =>
  sharp({ create: { width: size, height: size, channels: 4, background: colour } })
    .png()
    .toBuffer()
const colourAt = async (png: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const offset = (y * info.width + x) * 4
  return `#${[0, 1, 2].map((channel) => (data[offset + channel] ?? 0).toString(16).padStart(2, '0')).join('')}`
}
/** Everything a name's four files answer that could tell one name from another. */
const served = async (gateway: typeof app, name: string, key: string | null = null) =>
  Promise.all(
    FILES.map(async (file) => {
      const answer = await at(gateway, key, `/p/${name}/${file}`)
      return {
        file,
        status: answer.status,
        type: answer.headers.get('content-type'),
        cache: answer.headers.get('cache-control'),
        etag: answer.headers.get('etag'),
        bytes: answer.bytes.toString('base64'),
      }
    }),
  )
/** The four files a name with no icon of its own is served: its monogram. */
const monogramFiles = async (name: string) => {
  const { letter, colour } = monogramOf(name)
  const set = await renderedMonogram(letter, colour)
  return [set.png96, set.png192, set.png512, set.ico].map((bytes) => bytes.toString('base64'))
}
const sizeOf = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)]

type Icon = { src: string; mimeType?: string; sizes?: string[] }
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
}
/** The JSON-RPC answer to one MCP request, whether it came as JSON or as one event of a stream. */
const rpc = async (path: string, version: string, method: string, params: Record<string, unknown> = {}) => {
  const answer = await owner(path, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': version, 'mcp-method': method },
    // A 2026-07-28 request carries who asks in its own _meta; an initialize has its own params instead
    body: { jsonrpc: '2.0', id: 1, method, params: method === 'initialize' ? params : { ...params, _meta: ENVELOPE } },
  })
  expect([method, answer.status]).toEqual([method, 200])
  const text = answer.bytes.toString('utf8')
  return {
    text,
    json: JSON.parse(text.trimStart().startsWith('{') ? text : (text.match(/^data: (.*)$/m)?.[1] ?? 'null')),
  }
}
const initialize = (path: string, version: string) =>
  rpc(path, version, 'initialize', {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  })

let unbranded: Awaited<ReturnType<typeof served>>
beforeAll(async () => {
  // What `desk` is served before any pack has the name
  unbranded = await served(app, 'desk')
  await makePack(app, 'desk', 'Desk')
  await makePack(app, 'loud', 'Loud')
  await makePack(fetches, 'desk', 'Desk')
})

describe('the monogram every pack starts with', () => {
  it('is the first letter of its name on its name’s colour, in the pack and in its files', async () => {
    const { json } = await owner('/api/packs/desk')
    const { letter, colour } = monogramOf('desk')
    expect(json.icon).toMatchObject({ source: 'monogram', letter, colour, set: false })
    expect(json.icon.url).toBe(`http://localhost/p/desk/icon-96.png?v=${json.icon.etag}`)
    expect(json.palette).toEqual([...PALETTE])
    const card = (await owner('/api/packs')).json._embedded.packs.find((pack: { name: string }) => pack.name === 'desk')
    expect(card.icon).toEqual(json.icon)
    const files = await served(app, 'desk')
    expect(files.map((file) => file.bytes)).toEqual(await monogramFiles('desk'))
    expect(await colourAt(Buffer.from(files[2]?.bytes ?? '', 'base64'), 256, 40)).toBe(colour)
  })

  it('is served the same for a pack with no icon of its own as for a name no pack has', async () => {
    expect(await served(app, 'desk')).toEqual(unbranded)
    // A name no pack has gets its own monogram, the same way
    expect((await served(app, 'nope')).map((file) => file.bytes)).toEqual(await monogramFiles('nope'))
  })
})

describe('the icon files at a pack’s address', () => {
  it('are open, cached for an hour, with an ETag a repeat confirms', async () => {
    const files = await served(app, 'desk')
    expect(files.map(({ file, status, type, cache }) => [file, status, type, cache])).toEqual([
      ['icon-96.png', 200, 'image/png', 'public, max-age=3600'],
      ['icon-192.png', 200, 'image/png', 'public, max-age=3600'],
      ['icon-512.png', 200, 'image/png', 'public, max-age=3600'],
      ['favicon.ico', 200, 'image/x-icon', 'public, max-age=3600'],
    ])
    for (const [file, size] of [
      ['icon-96.png', 96],
      ['icon-192.png', 192],
      ['icon-512.png', 512],
    ] as const)
      expect(sizeOf(Buffer.from(files.find((one) => one.file === file)?.bytes ?? '', 'base64'))).toEqual([size, size])
    const again = await at(app, null, '/p/desk/icon-96.png', { headers: { 'if-none-match': files[0]?.etag ?? '' } })
    expect([again.status, again.bytes.length]).toEqual([304, 0])
    // Each file has its own ETag
    expect(new Set(files.map((file) => file.etag)).size).toBe(4)
  })

  it('answer a key of another pack, and the owner, as they answer no key', async () => {
    const key = await owner('/api/clients', {
      method: 'POST',
      body: { name: 'loud-agent', scope: 'read', pack: 'loud' },
    })
    expect(key.status).toBe(201)
    expect(await served(app, 'desk', key.json.key)).toEqual(await served(app, 'desk'))
    expect(await served(app, 'nope', key.json.key)).toEqual(await served(app, 'nope'))
    expect(await served(app, 'desk', OWNER)).toEqual(await served(app, 'desk'))
  })

  it('answer only the four files: the rest of the address still asks for credentials', async () => {
    for (const path of ['/p/desk/icon.svg', '/p/desk/icon-64.png', '/p/desk/site.webmanifest'])
      expect([path, (await at(app, null, path)).status]).toEqual([path, 401])
    expect((await at(app, null, '/p/Not_A_Name/icon-96.png')).status).toBe(404)
  })
})

describe('setting an icon', () => {
  const gateway = uploads
  beforeAll(async () => {
    await makePack(gateway, 'desk', 'Desk')
  })

  it('takes a PNG, and serves it in place of the monogram', async () => {
    const answer = await upload(gateway, 'desk', await square(256, '#cc2200'))
    expect(answer.status).toBe(200)
    expect(answer.json).toMatchObject({ source: 'upload', letter: 'D', colour: null, set: true })
    expect(answer.json._links.icon512.href).toBe('http://localhost/p/desk/icon-512.png')
    const file = await at(gateway, null, '/p/desk/icon-512.png')
    expect(await colourAt(file.bytes, 256, 256)).toBe('#cc2200')
    expect(answer.json.url).toBe(`http://localhost/p/desk/icon-96.png?v=${answer.json.etag}`)
    expect((await at(gateway, OWNER, '/api/packs/desk')).json.icon).toMatchObject({ source: 'upload' })
  })

  it('takes an SVG, drawn and kept as PNGs: the SVG itself is never served', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#123456"/></svg>'
    const answer = await upload(gateway, 'desk', Buffer.from(svg), 'image/svg+xml')
    expect(answer.status).toBe(200)
    const file = await at(gateway, null, '/p/desk/icon-192.png')
    expect([file.headers.get('content-type'), await colourAt(file.bytes, 96, 96)]).toEqual(['image/png', '#123456'])
    expect((await at(gateway, null, '/p/desk/icon.svg')).status).toBe(401)
  })

  it('refuses what is no icon, saying what to send', async () => {
    const before = await served(gateway, 'desk')
    const big = Buffer.alloc(1024 * 1024 + 1)
    big.set([137, 80, 78, 71, 13, 10, 26, 10])
    const refusals = [
      [await upload(gateway, 'desk', big), 413, /the most is 1 MB/],
      [await upload(gateway, 'desk', Buffer.from('plain words'), 'text/plain'), 415, /not a PNG or an SVG/],
      [
        await upload(
          gateway,
          'desk',
          await sharp({ create: { width: 300, height: 100, channels: 3, background: '#000' } })
            .png()
            .toBuffer(),
        ),
        400,
        /300 × 100, too far from square/,
      ],
      [
        await upload(gateway, 'desk', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect'), SVG),
        400,
        /couldn’t be read/,
      ],
    ] as const
    for (const [answer, status, detail] of refusals) {
      expect(answer.status).toBe(status)
      expect(answer.json.detail).toMatch(detail)
    }
    // What it had stays
    expect(await served(gateway, 'desk')).toEqual(before)
  })

  it('never fetches what an SVG links to: it is refused before anything reads it', async () => {
    let connections = 0
    const listener = createServer((_request, response) => response.end())
    listener.on('connection', () => {
      connections++
    })
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const port = (listener.address() as AddressInfo).port
    try {
      for (const svg of [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="http://127.0.0.1:${port}/a.png" width="10" height="10"/></svg>`,
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="url(http://127.0.0.1:${port}/p.svg#x)"/></svg>`,
        // Written with character references, which XML reads as the letters they name
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" style="fill:&#117;rl(http://127.0.0.1:${port}/p.svg#x)"/></svg>`,
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>&#64;import "http://127.0.0.1:${port}/a.css";</style><rect width="10" height="10"/></svg>`,
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" style="fill:u\\72l(http://127.0.0.1:${port}/p.svg#x)"/></svg>`,
      ]) {
        const answer = await upload(fetches, 'desk', Buffer.from(svg), SVG)
        expect([svg, answer.status]).toEqual([svg, 400])
        expect(answer.json.detail).toMatch(/points outside itself|CSS escapes/)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(connections).toBe(0)
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    }
  })

  it('is the owner’s alone, and only outside a pack', async () => {
    const key = await at(gateway, OWNER, '/api/clients', {
      method: 'POST',
      body: { name: 'desk-agent', scope: 'write', pack: 'desk' },
    })
    const png = await square(128, '#00ff00')
    expect((await upload(gateway, 'desk', png, PNG, key.json.key)).status).toBe(403)
    const inPack = await at(gateway, OWNER, '/p/desk/api/packs/desk/icon', {
      method: 'PUT',
      raw: png,
      headers: { 'content-type': PNG },
    })
    expect(inPack.status).toBe(403)
    expect((await upload(gateway, 'nope', png)).status).toBe(404)
    expect((await at(gateway, null, '/api/packs/desk/icon', { method: 'DELETE' })).status).toBe(401)
  })

  it('takes ten uploads an hour', async () => {
    // Every upload above counted, refused ones too: six so far
    for (let left = 4; left > 0; left--)
      expect((await upload(gateway, 'desk', await square(128, '#0000ff'))).status).toBe(200)
    const over = await upload(gateway, 'desk', await square(128, '#0000ff'))
    expect(over.status).toBe(429)
    expect(over.json.detail).toMatch(/Try again in \d+ seconds/)
    // Picking a colour is not an upload
    expect((await at(gateway, OWNER, '/api/packs/desk/icon', { method: 'DELETE' })).status).toBe(200)
  })
})

describe('an SVG that is slow to measure', () => {
  it('is stopped at its limit in a process of its own, while the gateway answers other requests', async () => {
    const order: string[] = []
    const started = Date.now()
    const refused = renderedUpload(Buffer.from(sizeless('<svg xmlns="http://www.w3.org/2000/svg">')), {
      seconds: 1,
    }).then(
      () => null,
      (error: unknown) => {
        order.push('upload')
        return error
      },
    )
    // A name no monogram was drawn for yet, so its answer needs sharp too
    const answered = await at(app, null, '/p/zed/icon-96.png')
    order.push('icon')
    const pack = await owner('/api/packs/desk')
    order.push('pack')
    const problem = await refused
    expect([answered.status, pack.status]).toEqual([200, 200])
    expect(order).toEqual(['icon', 'pack', 'upload'])
    expect(Date.now() - started).toBeLessThan(4000)
    expect(problem).toBeInstanceOf(ProblemError)
    expect((problem as ProblemError).message).toMatch(/took more than 1 second to draw.*simpler/)
  }, 30_000)
})

describe('an upload sent with no length', () => {
  it('is read only to just past 1 MB, then refused', async () => {
    const gateway = await made()
    await makePack(gateway, 'desk', 'Desk')
    // 64 MB, handed over a chunk at a time as it is read
    let pulled = 0
    const chunk = new Uint8Array(64 * 1024)
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulled >= 64 * 1024 * 1024) return controller.close()
          pulled += chunk.length
          controller.enqueue(chunk.slice())
        },
      },
      { highWaterMark: 0 },
    )
    const answer = await gateway.request('/api/packs/desk/icon', {
      method: 'PUT',
      headers: { authorization: `Bearer ${OWNER}`, 'content-type': PNG },
      body,
      duplex: 'half',
    } as RequestInit)
    expect(answer.status).toBe(413)
    expect(((await answer.json()) as { detail: string }).detail).toMatch(/more than 1 MB/)
    expect(pulled).toBeLessThan(2 * 1024 * 1024)
  })
})

describe('the monogram’s colour', () => {
  it('can be any of the palette, and goes back to the name’s own', async () => {
    const own = monogramOf('loud').colour
    const other = PALETTE.find((colour) => colour !== own) as string
    const picked = await owner('/api/packs/loud/icon', { method: 'PATCH', body: { colour: other } })
    expect(picked.status).toBe(200)
    expect(picked.json).toMatchObject({ source: 'monogram', letter: 'L', colour: other, set: true })
    expect(await colourAt((await at(app, null, '/p/loud/icon-512.png')).bytes, 256, 40)).toBe(other)
    const refused = await owner('/api/packs/loud/icon', { method: 'PATCH', body: { colour: '#123456' } })
    expect(refused.status).toBe(400)
    const reset = await owner('/api/packs/loud/icon', { method: 'DELETE' })
    expect(reset.json).toMatchObject({ source: 'monogram', colour: own, set: false })
    expect((await served(app, 'loud')).map((file) => file.bytes)).toEqual(await monogramFiles('loud'))
  })
})

describe('a renamed pack', () => {
  const gateway = renames
  beforeAll(async () => {
    await makePack(gateway, 'front', 'Front')
    // A key keeps the old name leading to the pack
    await at(gateway, OWNER, '/api/clients', {
      method: 'POST',
      body: { name: 'front-agent', scope: 'read', pack: 'front' },
    })
    const renamed = await at(gateway, OWNER, '/api/packs/front', { method: 'PATCH', body: { name: 'desk' } })
    expect(renamed.status).toBe(200)
  })

  it('takes the monogram of its new name, and its old name tells nothing while it has no icon of its own', async () => {
    expect((await served(gateway, 'desk')).map((file) => file.bytes)).toEqual(await monogramFiles('desk'))
    expect((await served(gateway, 'front')).map((file) => file.bytes)).toEqual(await monogramFiles('front'))
  })

  it('serves the icon the owner set at its old name too', async () => {
    expect((await upload(gateway, 'desk', await square(128, '#aa00aa'))).status).toBe(200)
    expect(await served(gateway, 'front')).toEqual(await served(gateway, 'desk'))
  })

  it('takes its icon along when it is removed', async () => {
    await makePack(gateway, 'temp', 'Temp')
    expect((await upload(gateway, 'temp', await square(128, '#aa00aa'))).status).toBe(200)
    expect((await at(gateway, OWNER, '/api/packs/temp', { method: 'DELETE' })).status).toBe(204)
    expect((await served(gateway, 'temp')).map((file) => file.bytes)).toEqual(await monogramFiles('temp'))
  })
})

describe('what agents see of it', () => {
  it('greets a pack connection with the pack’s icon, the inline PNG first, a 2025 client and a 2026-07-28 one alike', async () => {
    const icon96 = (await at(app, null, '/p/desk/icon-96.png')).bytes.toString('base64')
    for (const version of ['2025-06-18', '2026-07-28']) {
      const { serverInfo } = (await initialize('/p/desk/mcp', version)).json.result as {
        serverInfo: { name: string; icons: Icon[] }
      }
      expect(serverInfo.name).toBe('desk')
      expect(serverInfo.icons.map(({ src, mimeType, sizes }) => [src, mimeType, sizes])).toEqual([
        [`data:image/png;base64,${icon96}`, 'image/png', ['96x96']],
        ['http://localhost/p/desk/icon-192.png', 'image/png', ['192x192']],
        ['http://localhost/p/desk/icon-512.png', 'image/png', ['512x512']],
      ])
    }
    // The gateway keeps its own
    const root = (await initialize('/mcp', '2025-06-18')).json.result.serverInfo as { icons: Icon[] }
    expect(root.icons[1]?.src).toBe('http://localhost/icon-192.png')
  })

  it('sends the inline icon only on discover: every other 2026-07-28 answer carries the links alone', async () => {
    const discovered = await rpc('/p/desk/mcp', '2026-07-28', 'server/discover')
    expect(discovered.text).toContain('data:image/png;base64,')
    const listed = await rpc('/p/desk/mcp', '2026-07-28', 'tools/list')
    expect(listed.json.result.tools.length).toBeGreaterThan(0)
    expect(listed.text).not.toContain('data:image')
    expect(listed.text).toContain('http://localhost/p/desk/icon-192.png')
  })

  it('puts it on the pack’s OpenAPI document', async () => {
    const openapi = (await owner('/p/desk/openapi.json')).json
    expect(openapi.info['x-logo']).toMatchObject({ url: 'http://localhost/p/desk/icon-512.png', altText: 'Desk' })
  })
})

describe('a config export and import', () => {
  it('carries an uploaded icon and a picked colour to another gateway', async () => {
    const from = await made()
    await makePack(from, 'desk', 'Desk')
    await makePack(from, 'loud', 'Loud')
    await makePack(from, 'quiet', 'Quiet')
    expect((await upload(from, 'desk', await square(200, '#336699'))).status).toBe(200)
    const other = PALETTE.find((colour) => colour !== monogramOf('loud').colour) as string
    await at(from, OWNER, '/api/packs/loud/icon', { method: 'PATCH', body: { colour: other } })
    const exported = (await at(from, OWNER, '/api/config')).json
    const icons = Object.fromEntries(
      exported.packs.map((pack: { name: string; icon: unknown }) => [pack.name, pack.icon]),
    )
    expect(icons).toMatchObject({ desk: { png: expect.any(String) }, loud: { colour: other }, quiet: null })

    const to = await made()
    // A pack that is there already keeps the icon it has
    await makePack(to, 'quiet', 'Quiet')
    const kept = await upload(to, 'quiet', await square(128, '#999999'))
    const imported = await at(to, OWNER, '/api/config', { method: 'POST', body: exported })
    expect(imported.status).toBe(200)
    expect(imported.json.skipped).toEqual([])
    expect(await served(to, 'desk')).toEqual(await served(from, 'desk'))
    expect(await served(to, 'loud')).toEqual(await served(from, 'loud'))
    expect((await at(to, OWNER, '/api/packs/quiet')).json.icon.etag).toBe(kept.json.etag)
  })
})
