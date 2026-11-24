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
export const UPLOAD_MAX = 1024 * 1024
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

/** What an SVG would reach outside itself: anything but a link inside it (a data: one is an image, refused as one). */
const OUTSIDE = [
  /\bhref\s*=\s*["']\s*(?!#|data:)([^"']{0,60})/i,
  /url\(\s*["']?\s*(?!#|data:)([^)"']{0,60})/i,
  /(@import)/i,
  /<(\w+:include)\b/i,
]
/** An image in an SVG, embedded or not: librsvg reads one at the size it declares, past any limit set here. */
const IMAGE = [/<(?:\w+:)?(?:image|feImage)[\s>/]/i, /(?:\bhref\s*=\s*["']|url\(\s*["']?)\s*data:/i]

const refused = (detail: string) => new ProblemError('bad_request', { detail })
/** The widest an icon's sides may differ: within 4:5 of each other. */
const [RATIO_MIN, RATIO_MAX] = [0.8, 1.25]
const tooFarFromSquare = (width: number, height: number) => {
  const ratio = width / height
  return ratio < RATIO_MIN || ratio > RATIO_MAX
}
const notSquare = (width: number, height: number) =>
  refused(
    `The icon is ${width} × ${height}, too far from square (its sides within 4:5 of each other). Crop it square and send it again.`,
  )
const unreadable = (kind: 'PNG' | 'SVG', error: unknown) =>
  refused(
    `The ${kind} couldn’t be read (${error instanceof Error ? error.message : String(error)}): open it in an editor, export it again, and send that.`,
  )

/**
 * Checks what an SVG holds before anything reads it: no DOCTYPE or entities, no CSS escapes, nothing outside itself
 * however it is spelt (librsvg fetches nothing remote, and this keeps it that way), no image, and no text, which the
 * server has no fonts to draw.
 */
const checkSvg = (source: string) => {
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw refused(
      'The SVG declares a DOCTYPE or entities, which an icon doesn’t take: remove the <!DOCTYPE …> and send it again.',
    )
  // Read as librsvg reads it: a character reference is the character it names
  const text = source.replace(/&#(x[0-9a-f]+|\d+);/gi, (written, code: string) => {
    const point = code.startsWith('x') || code.startsWith('X') ? Number.parseInt(code.slice(1), 16) : Number(code)
    return point <= 0x10ffff ? String.fromCodePoint(point) : written
  })
  if (/\\[0-9a-f]/i.test(text))
    throw refused(
      'The SVG writes CSS escapes (a backslash and a code), which an icon doesn’t take: write the CSS plainly and send it again.',
    )
  if (/<(text|tspan|textPath)[\s>/]/.test(text))
    throw refused(
      'The SVG has text, and Yardhand draws icons with no fonts installed, so its letters would come out as boxes: in your editor, convert it to outlines (paths) and send it again.',
    )
  for (const pattern of OUTSIDE) {
    const found = pattern.exec(text)
    if (found)
      throw refused(
        `The SVG points outside itself (${found[1]?.trim() || found[0].trim()}): an icon is drawn from the file alone, and nothing it links to is fetched. Remove the link and send it again.`,
      )
  }
  if (IMAGE.some((pattern) => pattern.test(text)))
    throw refused(
      'The SVG has an image in it, which an icon doesn’t take: send the image as a PNG instead, or remove it from the SVG and send that.',
    )
}

/**
 * Reads an SVG (stdin) and draws it into a 512 PNG (stdout); run as `node -e` with sharp's path. Its size is read here
 * too: librsvg walks the whole drawing to measure one that gives none. What stops it goes to stderr as JSON, for the
 * gateway to word: the size it read (`{ width, height }`) or why it couldn't (`{ unreadable }`).
 */
const DRAW_SCRIPT = `const chunks = []
const stop = (report) => {
  process.stderr.write(JSON.stringify(report))
  process.exitCode = 1
}
process.stdin.on('data', (chunk) => chunks.push(chunk)).on('end', async () => {
  try {
    const sharp = require(process.argv[1])
    const svg = Buffer.concat(chunks)
    const meta = await sharp(svg, { limitInputPixels: false }).metadata()
    const { width = 0, height = 0 } = meta
    if (meta.format !== 'svg' || !width || !height) return stop({ unreadable: 'it reads as ' + (meta.format ?? 'nothing') })
    if (width / height < ${RATIO_MIN} || width / height > ${RATIO_MAX}) return stop({ width, height })
    // Drawn at the density that makes its longer side 512, whatever size it declares
    const density = Math.min(100000, Math.max(1, (72 * 512) / Math.max(width, height)))
    const drawn = await sharp(svg, { density })
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
    process.stdout.write(drawn)
  } catch (error) {
    stop({ unreadable: error instanceof Error ? error.message : String(error) })
  }
})`

/** The refusal for what the drawing process reported on stderr. */
const refusalOf = (reported: string, code: number | null) => {
  try {
    const report = JSON.parse(reported) as { width?: number; height?: number; unreadable?: string }
    if (report.width && report.height) return notSquare(report.width, report.height)
    if (report.unreadable) return unreadable('SVG', report.unreadable)
  } catch {}
  return unreadable('SVG', reported || `the drawing stopped (${code})`)
}

/** The draw running now: SVGs are drawn one at a time. */
let drawing: Promise<unknown> = Promise.resolve()

/**
 * Reads and draws an SVG in a process of its own with no environment, killed once it runs past its time: librsvg
 * measures and draws in steps that sharp's own timeout can't stop, and a small SVG can ask for minutes of either.
 */
const drawnApart = (svg: Buffer, seconds: number): Promise<Buffer> => {
  const drawn = drawing.then(async () => {
    const { spawn } = await import('node:child_process')
    const { createRequire } = await import('node:module')
    const sharpPath = createRequire(import.meta.url).resolve('sharp')
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', DRAW_SCRIPT, sharpPath], { env: {} })
      const [out, err]: [Buffer[], Buffer[]] = [[], []]
      let late = false
      const timer = setTimeout(() => {
        late = true
        child.kill('SIGKILL')
      }, seconds * 1000)
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
      child.stdin.on('error', () => {})
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (late)
          reject(
            refused(
              `The SVG took more than ${seconds} second${seconds === 1 ? '' : 's'} to draw, so it was stopped: an icon is a few shapes. Make it simpler (fewer masks, filters and repeated parts), or export it as a PNG, and send it again.`,
            ),
          )
        else if (code === 0) resolve(Buffer.concat(out))
        else reject(refusalOf(Buffer.concat(err).toString('utf8'), code))
      })
      child.stdin.end(svg)
    })
  })
  drawing = drawn.catch(() => undefined)
  return drawn
}

/** Whether a body reads as an SVG: markup from its first character (past a byte-order mark), an `<svg` in it. */
const isSvgText = (text: string) => /^\uFEFF?\s*</.test(text) && /<svg[\s>]/i.test(text)

/**
 * An uploaded icon's files: a PNG of at least 96 × 96 or an SVG, at most 1 MB, within 4:5 of square (padded to
 * square, clear), drawn at 512, an SVG in at most `seconds`. Refused with a problem that says what to send instead.
 */
export const renderedUpload = async (bytes: Uint8Array, { seconds = 10 } = {}): Promise<IconSet> => {
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
  if (!png) {
    checkSvg(text)
    // Read, measured and drawn apart: nothing in this process reads an SVG
    return setOf(
      await drawnApart(input, seconds).catch((error: unknown) => {
        throw error instanceof ProblemError ? error : unreadable('SVG', error)
      }),
    )
  }
  const sharp = await sharpOf()
  const meta = await sharp(input, { limitInputPixels: false })
    .metadata()
    .catch((error: unknown) => {
      throw unreadable('PNG', error)
    })
  const { width = 0, height = 0 } = meta
  if (meta.format !== 'png' || !width || !height) throw unreadable('PNG', `it reads as ${meta.format ?? 'nothing'}`)
  if (width * height > PIXELS_MAX)
    throw refused(`The PNG is ${width} × ${height}: more than 4096 × 4096. Send it at 512 × 512.`)
  if (width < 96 || height < 96)
    throw refused(
      `The PNG is ${width} × ${height}; an icon needs at least 96 × 96. Send a larger one (512 × 512 is best), or an SVG.`,
    )
  if (tooFarFromSquare(width, height)) throw notSquare(width, height)
  const master = await sharp(input, { limitInputPixels: PIXELS_MAX })
    .timeout({ seconds })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
    .catch((error: unknown) => {
      throw unreadable('PNG', error)
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
  /** Whether the owner set it: false is the monogram every name gets. */
  set: boolean
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
  const of = async (pack: PackRow): Promise<PackIcon & { files: IconSet }> => {
    const row = await packs.iconOf(pack.id)
    const own = monogramOf(pack.name)
    if (row?.source === 'upload' && row.png96 && row.png192 && row.png512 && row.ico && row.etag) {
      const set = { png96: row.png96, png192: row.png192, png512: row.png512, ico: row.ico, etag: row.etag }
      return { source: 'upload', letter: own.letter, colour: null, set: true, etag: row.etag, files: set }
    }
    const colour = (PALETTE as readonly string[]).includes(row?.colour ?? '') ? (row?.colour as IconColour) : own.colour
    const files = await monogram(own.letter, colour)
    return { source: 'monogram', letter: own.letter, colour, set: Boolean(row), etag: files.etag, files }
  }
  return {
    of,
    /**
     * What `/p/<name>/` serves: the icon of the pack named so now, or of the pack a former name leads to when the
     * owner set it one; any other name, its own monogram. A pack the owner never gave an icon looks like no pack.
     */
    at: async (name: string): Promise<IconSet> => {
      const holder = await packs.holderOf(name)
      if (holder && (holder.until === null || (await packs.iconOf(holder.pack.id))))
        return (await of(holder.pack)).files
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
