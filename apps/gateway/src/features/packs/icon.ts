/**
 * A pack's icon: one the owner uploaded (an SVG or a PNG, rendered once into PNGs and a favicon; the file sent is never
 * kept), else a monogram, the first letter of its name in white on a colour from a fixed palette, picked by the name
 * unless the owner picked another. Everything is rendered here, with sharp; nothing is ever served as SVG.
 *
 * The icon files are open at `/p/<name>/`, so every name gets one: a name no pack has, and a pack with no icon of its
 * own, get the name's monogram alike. Only an icon the owner set is a pack's own.
 */
import { createHash } from 'node:crypto'
import { icoOf, ProblemError } from '../../kit/index.js'
import { CAP_HEIGHT, GLYPHS } from './glyphs.js'
import type { PacksRepo } from './repo.js'
import type { PackRow } from './schema.js'

/** The colours a monogram is drawn on: each reads white text at 4.5:1 or better. */
export const PALETTE = [
  '#006ad9',
  '#6d28d9',
  '#a21caf',
  '#be185d',
  '#b91c1c',
  '#c2410c',
  '#a16207',
  '#15803d',
  '#0f766e',
  '#475569',
] as const
export type IconColour = (typeof PALETTE)[number]

/** Claude shows an inline icon only under 10 KB. */
export const INLINE_MAX = 10 * 1024
const UPLOAD_MAX = 1024 * 1024
/** The most pixels a PNG may hold, read or not: a small file can still unpack to a huge image. */
const PIXELS_MAX = 4096 * 4096
const PNG = [137, 80, 78, 71, 13, 10, 26, 10]

/** Every file served for one icon, and the version of all four. */
export type IconSet = { png96: Buffer; png192: Buffer; png512: Buffer; ico: Buffer; etag: string }

/** FNV-1a over the name: the same name lands on the same colour on every install. */
const hashOf = (name: string) => {
  let hash = 0x811c9dc5
  for (const char of name) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193)
  return hash >>> 0
}

/** The monogram a name gets: its first character, upper case, on the palette colour its hash picks. */
export const monogramOf = (name: string): { letter: string; colour: IconColour } => ({
  letter: name.charAt(0).toUpperCase(),
  colour: PALETTE[hashOf(name) % PALETTE.length] as IconColour,
})

/** The monogram as an SVG, only ever rendered here: the letter centred on a rounded tile, cap height 46% of it. */
const monogramSvg = (letter: string, colour: string) => {
  const glyph = GLYPHS[letter] ?? GLYPHS.A
  const scale = 236 / CAP_HEIGHT
  const x = 256 - (scale * ((glyph?.x[0] ?? 0) + (glyph?.x[1] ?? 0))) / 2
  const y = 256 + (scale * CAP_HEIGHT) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="${colour}"/><path fill="#ffffff" transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(6)})" d="${glyph?.d ?? ''}"/></svg>`
}

const sharpOf = async () => (await import('sharp')).default

/** The served files from a square 512 PNG: the 96 one cut to a palette, so it rides inline under 10 KB. */
const setOf = async (master: Buffer): Promise<IconSet> => {
  const sharp = await sharpOf()
  const at = (size: number) => sharp(master).resize(size, size).png({ compressionLevel: 9 }).toBuffer()
  const png512 = await sharp(master).png({ compressionLevel: 9 }).toBuffer()
  const png192 = await at(192)
  let png96 = Buffer.alloc(0)
  for (const colours of [256, 64, 16]) {
    png96 = await sharp(master)
      .resize(96, 96)
      .png({ palette: true, colours, effort: 10, compressionLevel: 9 })
      .toBuffer()
    if (png96.length < INLINE_MAX) break
  }
  const ico = Buffer.from(icoOf([await at(16), await at(32), await at(48)]))
  const etag = createHash('sha256').update(png512).update(png192).update(png96).update(ico).digest('hex').slice(0, 16)
  return { png96, png192, png512, ico, etag }
}

/** A monogram's files. */
export const renderedMonogram = async (letter: string, colour: string) => {
  const sharp = await sharpOf()
  return setOf(
    await sharp(Buffer.from(monogramSvg(letter, colour)))
      .png()
      .toBuffer(),
  )
}

/** What an SVG would reach outside itself: anything but a link inside it or an image embedded as a data: PNG or JPEG. */
const OUTSIDE = [
  /\bhref\s*=\s*["']\s*(?!#|data:image\/(?:png|jpeg);)([^"']{0,60})/i,
  /url\(\s*["']?\s*(?!#|data:image\/(?:png|jpeg);)([^)"']{0,60})/i,
  /(@import)/i,
  /<(\w+:include)\b/i,
]

const refused = (detail: string) => new ProblemError('bad_request', { detail })
const tooFarFromSquare = (width: number, height: number) => {
  const ratio = width / height
  return ratio < 0.8 || ratio > 1.25
}

/**
 * Checks what an SVG holds before anything reads it: no DOCTYPE or entities, and nothing outside itself (librsvg
 * fetches nothing remote, and this keeps it that way).
 */
const checkSvg = (text: string) => {
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw refused(
      'The SVG declares a DOCTYPE or entities, which an icon doesn’t take: remove the <!DOCTYPE …> and send it again.',
    )
  for (const pattern of OUTSIDE) {
    const found = pattern.exec(text)
    if (found)
      throw refused(
        `The SVG points outside itself (${found[1]?.trim() || found[0].trim()}): an icon is drawn from the file alone, and nothing it links to is fetched. Embed an image as a data: PNG or JPEG, or remove the link, and send it again.`,
      )
  }
}

/** The first characters of a text body, past a byte-order mark and blank space. */
const isSvgText = (text: string) => /^﻿?\s*</.test(text) && /<svg[\s>]/i.test(text)

/**
 * An uploaded icon's files: a PNG of at least 96 × 96 or an SVG, at most 1 MB, within 4:5 of square (padded to
 * square, clear), drawn at 512. Refused with a problem that says what to send instead.
 */
export const renderedUpload = async (bytes: Uint8Array): Promise<IconSet> => {
  if (!bytes.length)
    throw refused('Send the icon as the body: a PNG or an SVG (content-type image/png or image/svg+xml).')
  if (bytes.length > UPLOAD_MAX)
    throw new ProblemError('payload_too_large', {
      detail: `The icon is ${Math.ceil(bytes.length / 1024)} KB; the most is 1 MB. Send a smaller PNG or SVG (512 × 512 is plenty).`,
    })
  const input = Buffer.from(bytes)
  const png = PNG.every((byte, at) => input[at] === byte)
  const text = png ? '' : input.toString('utf8')
  if (!png && !isSvgText(text))
    throw new ProblemError('unsupported_media_type', {
      detail:
        'That file is not a PNG or an SVG (JPEG, WebP and GIF are not taken): export the icon as a PNG or an SVG and send it again.',
    })
  if (!png) checkSvg(text)
  const kind = png ? 'PNG' : 'SVG'
  const sharp = await sharpOf()
  const unreadable = (error: unknown) =>
    refused(
      `The ${kind} couldn’t be read (${error instanceof Error ? error.message : String(error)}): open it in an editor, export it again, and send that.`,
    )
  const meta = await sharp(input, { limitInputPixels: false })
    .metadata()
    .catch((error: unknown) => {
      throw unreadable(error)
    })
  const { width = 0, height = 0 } = meta
  if (meta.format !== (png ? 'png' : 'svg') || !width || !height)
    throw unreadable(`it reads as ${meta.format ?? 'nothing'}`)
  if (png && width * height > PIXELS_MAX)
    throw refused(`The PNG is ${width} × ${height}: more than 4096 × 4096. Send it at 512 × 512.`)
  if (png && (width < 96 || height < 96))
    throw refused(
      `The PNG is ${width} × ${height}; an icon needs at least 96 × 96. Send a larger one (512 × 512 is best), or an SVG.`,
    )
  if (tooFarFromSquare(width, height))
    throw refused(
      `The icon is ${width} × ${height}, too far from square (its sides within 4:5 of each other). Crop it square and send it again.`,
    )
  // An SVG is drawn at the density that makes its longer side 512, whatever size it declares
  const density = png ? undefined : Math.min(100_000, Math.max(1, (72 * 512) / Math.max(width, height)))
  const master = await sharp(input, { limitInputPixels: PIXELS_MAX, ...(density ? { density } : {}) })
    .timeout({ seconds: 10 })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
    .catch((error: unknown) => {
      throw unreadable(error)
    })
  return setOf(master)
}

/** Claude reads a serverInfo of about 16,000 characters at most. */
const SERVER_INFO_MAX = 15_000

/**
 * A pack's MCP icons, as the kit orders the gateway's: the 96 PNG inline (when asked for, under 10 KB, and the whole
 * serverInfo stays small enough to be read), then the 192 and 512 PNGs at the pack's address. No SVG: none is served.
 */
export const packMcpIcons = (info: object & { name: string }, origin: string, set: IconSet, inline: boolean) => {
  const at = (size: number) => ({
    src: `${origin}/p/${info.name}/icon-${size}.png`,
    mimeType: 'image/png',
    sizes: [`${size}x${size}`],
  })
  const linked = [at(192), at(512)]
  const data = { src: `data:image/png;base64,${set.png96.toString('base64')}`, mimeType: 'image/png', sizes: ['96x96'] }
  const fits =
    set.png96.length < INLINE_MAX && JSON.stringify({ ...info, icons: [data, ...linked] }).length < SERVER_INFO_MAX
  return inline && fits ? [data, ...linked] : linked
}

/** A pack's icon as the API shows it. */
export type PackIcon = {
  source: 'upload' | 'monogram'
  letter: string
  /** The monogram's colour; null while an uploaded icon is shown. */
  colour: IconColour | null
  etag: string
}

/**
 * The icons of packs: each pack's, and what every name's address serves. Monograms are rendered once per letter and
 * colour, never per name, since anyone may ask for any name.
 */
export const createPackIcons = ({ packs }: { packs: PacksRepo }) => {
  const monograms = new Map<string, Promise<IconSet>>()
  const monogram = (letter: string, colour: string) => {
    const key = `${letter} ${colour}`
    if (!monograms.has(key))
      monograms.set(
        key,
        renderedMonogram(letter, colour).catch((error: unknown) => {
          monograms.delete(key)
          throw error
        }),
      )
    return monograms.get(key) as Promise<IconSet>
  }
  /** A pack's icon and its files: its upload, else its monogram in the colour the owner picked or its name's. */
  const of = async (pack: PackRow): Promise<PackIcon & { set: IconSet }> => {
    const row = await packs.iconOf(pack.id)
    const own = monogramOf(pack.name)
    if (row?.source === 'upload' && row.png96 && row.png192 && row.png512 && row.ico && row.etag) {
      const set = { png96: row.png96, png192: row.png192, png512: row.png512, ico: row.ico, etag: row.etag }
      return { source: 'upload', letter: own.letter, colour: null, etag: row.etag, set }
    }
    const colour = (PALETTE as readonly string[]).includes(row?.colour ?? '') ? (row?.colour as IconColour) : own.colour
    const set = await monogram(own.letter, colour)
    return { source: 'monogram', letter: own.letter, colour, etag: set.etag, set }
  }
  return {
    of,
    /**
     * What `/p/<name>/` serves: the icon of the pack named so now, or of the pack a former name leads to when the
     * owner set it one; any other name, its own monogram. A pack the owner never gave an icon looks like no pack.
     */
    at: async (name: string): Promise<IconSet> => {
      const holder = await packs.holderOf(name)
      if (holder && (holder.until === null || (await packs.iconOf(holder.pack.id)))) return (await of(holder.pack)).set
      const { letter, colour } = monogramOf(name)
      return monogram(letter, colour)
    },
    /** Renders an upload and keeps its files; the file sent is not kept. */
    upload: async (pack: PackRow, bytes: Uint8Array) => {
      const set = await renderedUpload(bytes)
      await packs.setIcon(pack.id, { source: 'upload', colour: null, ...set })
    },
    /** The monogram in a colour of the palette, in place of whatever icon it had. */
    recolour: (pack: PackRow, colour: IconColour) =>
      packs.setIcon(pack.id, {
        source: 'monogram',
        colour,
        png96: null,
        png192: null,
        png512: null,
        ico: null,
        etag: null,
      }),
    /** Back to the name's own monogram. */
    reset: (pack: PackRow) => packs.removeIcon(pack.id),
  }
}

export type PackIcons = ReturnType<typeof createPackIcons>
