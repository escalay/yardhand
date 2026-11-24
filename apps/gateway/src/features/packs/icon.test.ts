import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { ProblemError } from '../../kit/index.js'
import {
  type IconSet,
  INLINE_MAX,
  monogramOf,
  PALETTE,
  packMcpIcons,
  renderedMonogram,
  renderedUpload,
} from './icon.js'

/** The WCAG contrast of white on a `#rrggbb` colour. */
const contrastOnWhite = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 1.05 / (0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0) + 0.05)
}
const sizeOf = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)]
/** The pixel at one point of a PNG: its colour as `#rrggbb`, and its alpha. */
const pixelAt = async (png: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (y * info.width + x) * 4
  const colour = `#${[0, 1, 2].map((channel) => (data[at + channel] ?? 0).toString(16).padStart(2, '0')).join('')}`
  return { colour, alpha: data[at + 3] }
}
const colourAt = async (png: Buffer, x: number, y: number) => (await pixelAt(png, x, y)).colour
const refusal = async (bytes: Uint8Array, limits?: { seconds: number }) => {
  const error = await renderedUpload(bytes, limits).then(
    () => null,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(ProblemError)
  return error as ProblemError
}
const square = (size: number, colour = '#3355ee') =>
  sharp({ create: { width: size, height: size, channels: 4, background: colour } })
    .png()
    .toBuffer()

/** Every file of a set is the size it says, the favicon an ICO of 16, 32 and 48. */
const expectWhole = (set: IconSet) => {
  expect(sizeOf(set.png96)).toEqual([96, 96])
  expect(sizeOf(set.png192)).toEqual([192, 192])
  expect(sizeOf(set.png512)).toEqual([512, 512])
  expect([set.ico.readUInt16LE(2), set.ico.readUInt16LE(4), set.ico[6], set.ico[22], set.ico[38]]).toEqual([
    1, 3, 16, 32, 48,
  ])
  expect(set.png96.length).toBeLessThan(INLINE_MAX)
  expect(set.etag).toMatch(/^[0-9a-f]{16}$/)
}

describe('the monogram', () => {
  it('takes its letter and colour from the name, the same every time', () => {
    expect(monogramOf('desk')).toEqual(monogramOf('desk'))
    expect(monogramOf('desk').letter).toBe('D')
    expect(monogramOf('7-seas').letter).toBe('7')
    expect(PALETTE).toContain(monogramOf('desk').colour)
    // Names spread over the palette rather than landing on one colour
    const colours = new Set(
      ['alpha', 'beta', 'desk', 'loud', 'quiet', 'kit', 'support', 'notes'].map((name) => monogramOf(name).colour),
    )
    expect(colours.size).toBeGreaterThan(3)
  })

  it('is drawn from colours white reads well on', () => {
    expect(PALETTE.length).toBeGreaterThanOrEqual(8)
    expect(PALETTE.length).toBeLessThanOrEqual(10)
    for (const colour of PALETTE) expect([colour, contrastOnWhite(colour) >= 4.5]).toEqual([colour, true])
  })

  it('renders every file, white on its colour, with no font installed', async () => {
    const set = await renderedMonogram('D', '#0f766e')
    expectWhole(set)
    // The colour fills the tile, the letter is white, and the rounded corner is clear
    expect(await colourAt(set.png512, 256, 40)).toBe('#0f766e')
    expect(await colourAt(set.png512, 40, 256)).toBe('#0f766e')
    expect(await colourAt(set.png512, 160, 256)).toBe('#ffffff')
    expect((await pixelAt(set.png512, 2, 2)).alpha).toBe(0)
    // Rendering again gives the same bytes, so its ETag holds
    expect((await renderedMonogram('D', '#0f766e')).etag).toBe(set.etag)
    expect((await renderedMonogram('E', '#0f766e')).etag).not.toBe(set.etag)
  })
})

describe('an uploaded icon', () => {
  it('takes a PNG, padding a nearly square one to square', async () => {
    const set = await renderedUpload(
      await sharp({ create: { width: 200, height: 180, channels: 4, background: '#cc2200' } })
        .png()
        .toBuffer(),
    )
    expectWhole(set)
    expect(await colourAt(set.png512, 256, 256)).toBe('#cc2200')
    // The padding is clear
    expect((await pixelAt(set.png512, 256, 4)).alpha).toBe(0)
  })

  it('takes an SVG, drawn at the full size whatever size it says it is', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" fill="#112233"/><circle cx="8" cy="8" r="4" fill="#ffffff"/></svg>'
    const set = await renderedUpload(Buffer.from(svg))
    expectWhole(set)
    expect(await colourAt(set.png512, 10, 10)).toBe('#112233')
    expect(await colourAt(set.png512, 256, 256)).toBe('#ffffff')
  })

  it('takes an SVG with an image embedded as a data: PNG, and links inside itself', async () => {
    const png = (await square(8, '#00aa00')).toString('base64')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><defs><rect id="r" width="10" height="10" fill="url(#g)"/><linearGradient id="g"><stop stop-color="#000"/></linearGradient></defs><use xlink:href="#r"/><image href="data:image/png;base64,${png}" width="10" height="10"/></svg>`
    expectWhole(await renderedUpload(Buffer.from(svg)))
  })

  it('gives back what a set was made from: its 512 PNG renders to the same set', async () => {
    const first = await renderedUpload(await square(300))
    expect((await renderedUpload(first.png512)).etag).toBe(first.etag)
  })

  it('refuses what is not a PNG or an SVG', async () => {
    const jpeg = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#ffffff' } })
      .jpeg()
      .toBuffer()
    for (const bytes of [jpeg, Buffer.from('just some words'), Buffer.from('{"svg": "<svg/>"}')]) {
      const problem = await refusal(bytes)
      expect(problem.code).toBe('unsupported_media_type')
      expect(problem.message).toMatch(/not a PNG or an SVG/)
    }
    expect((await refusal(new Uint8Array())).message).toMatch(/Send the icon as the body/)
  })

  it('refuses a file over 1 MB before reading it', async () => {
    const big = Buffer.alloc(1024 * 1024 + 1)
    big.set([137, 80, 78, 71, 13, 10, 26, 10])
    const problem = await refusal(big)
    expect(problem.code).toBe('payload_too_large')
    expect(problem.message).toMatch(/the most is 1 MB/)
  })

  it('refuses a PNG under 96 pixels, or too far from square', async () => {
    expect((await refusal(await square(64))).message).toMatch(/64 × 64; an icon needs at least 96 × 96/)
    const wide = await sharp({ create: { width: 400, height: 200, channels: 4, background: '#000000' } })
      .png()
      .toBuffer()
    expect((await refusal(wide)).message).toMatch(/400 × 200, too far from square/)
    const tall = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="30"><rect width="10" height="30"/></svg>'
    expect((await refusal(Buffer.from(tall))).message).toMatch(/10 × 30, too far from square/)
  })

  it('refuses an SVG that points outside itself, before anything reads it', async () => {
    for (const reference of [
      '<image href="http://127.0.0.1:9/x.png" width="10" height="10"/>',
      '<image xlink:href="https://example.com/x.png" width="10" height="10"/>',
      '<image href="file:///etc/passwd" width="10" height="10"/>',
      '<image href="x.png" width="10" height="10"/>',
      '<image href="data:image/svg+xml;base64,PHN2Zy8+" width="10" height="10"/>',
      '<use href="other.svg#a"/>',
      '<rect width="10" height="10" style="fill: url(http://example.com/a.svg#p)"/>',
      '<style>@import url("https://example.com/a.css");</style>',
      '<image href="&#104;ttp://example.com/x.png" width="10" height="10"/>',
    ]) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">${reference}</svg>`
      const problem = await refusal(Buffer.from(svg))
      expect([reference, problem.code]).toEqual([reference, 'bad_request'])
      expect(problem.message).toMatch(/points outside itself/)
    }
  })

  it('refuses an SVG with text, which would be drawn with no fonts: its letters as outlines are taken', async () => {
    for (const text of ['<text x="1" y="8">A</text>', '<g><text><tspan>A</tspan></text></g>']) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${text}</svg>`
      expect((await refusal(Buffer.from(svg))).message).toMatch(/has text.*convert it to outlines/)
    }
  })

  it('refuses an SVG with a DOCTYPE or entities', async () => {
    const svg =
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/hostname">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>&x;</text></svg>'
    expect((await refusal(Buffer.from(svg))).message).toMatch(/DOCTYPE/)
  })

  it('stops drawing an SVG at its time limit, however long the drawing would take', async () => {
    // A kilobyte asking for ten thousand masked squares, each drawn over the whole icon: about 10 s to draw
    let defs = `<mask id="m"><rect width="512" height="512" fill="white" opacity="0.5"/></mask><g id="g0">${'<rect width="512" height="512" fill="red" mask="url(#m)"/>'.repeat(10)}</g>`
    for (let level = 1; level <= 3; level++)
      defs += `<g id="g${level}">${`<use href="#g${level - 1}"/>`.repeat(10)}</g>`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs>${defs}</defs><use href="#g3"/></svg>`
    const started = Date.now()
    const problem = await refusal(Buffer.from(svg), { seconds: 1 })
    expect(Date.now() - started).toBeLessThan(4000)
    expect(problem.message).toMatch(/took more than 1 second to draw.*simpler/)
  }, 30_000)

  it('refuses an SVG or a PNG it cannot read, saying what to do', async () => {
    const broken = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"'
    const svg = await refusal(Buffer.from(broken))
    expect(svg.code).toBe('bad_request')
    expect(svg.message).toMatch(/The SVG couldn’t be read.*export it again/)
    const png = Buffer.concat([(await square(128)).subarray(0, 40)])
    expect((await refusal(png)).message).toMatch(/The PNG couldn’t be read/)
  })
})

describe('a pack’s MCP icons', () => {
  it('lead with the inline 96 PNG when asked, and leave it out when the greeting would grow too long to read', async () => {
    const set = await renderedMonogram('D', '#0f766e')
    const info = { name: 'desk', description: 'Answers at the desk.' }
    const linked = ['https://gw.example.com/p/desk/icon-192.png', 'https://gw.example.com/p/desk/icon-512.png']
    const inline = packMcpIcons(info, 'https://gw.example.com', set, true)
    expect(inline[0]?.src).toBe(`data:image/png;base64,${set.png96.toString('base64')}`)
    expect(inline.slice(1).map((icon) => icon.src)).toEqual(linked)
    expect(packMcpIcons(info, 'https://gw.example.com', set, false).map((icon) => icon.src)).toEqual(linked)
    const long = { ...info, description: 'x'.repeat(14_000) }
    expect(packMcpIcons(long, 'https://gw.example.com', set, true).map((icon) => icon.src)).toEqual(linked)
  })
})
