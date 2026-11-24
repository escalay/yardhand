/**
 * A pack's icon: the owner's routes to set it, and its files, open at the pack's address. Every name is served
 * (`packIcons.at`), so a pack with no icon of its own and a name no pack has answer alike: same status, headers and
 * bytes. Nothing here reads the caller, so a key changes nothing either.
 */
import type { OpenAPIHono, RouteHandler } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { requireOwner } from '../clients/principals.js'
import type { IconSet, PackIcon } from './icon.js'
import type { iconRoutes } from './icon.routes.js'
import { noPack } from './names.js'
import { PATH } from './routes.js'
import type { PackRow } from './schema.js'

type Routes = typeof iconRoutes

/** The files at `/p/<pack>/`, each with its type and the part of the set it is. */
const FILES = {
  'icon-96.png': { type: 'image/png', of: (set: IconSet) => set.png96 },
  'icon-192.png': { type: 'image/png', of: (set: IconSet) => set.png192 },
  'icon-512.png': { type: 'image/png', of: (set: IconSet) => set.png512 },
  'favicon.ico': { type: 'image/x-icon', of: (set: IconSet) => set.ico },
} as const

/** The paths left open to anyone, as `auth.open` takes them (a star inside matches one segment). */
export const PACK_ICON_PATHS = Object.keys(FILES).map((file) => `/p/*/${file}`)

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

/** A pack's icon as the API shows it, with its 96 PNG's address. */
export const iconView = (origin: string, pack: PackRow, icon: PackIcon) => ({
  source: icon.source,
  letter: icon.letter,
  colour: icon.colour,
  set: icon.set,
  etag: icon.etag,
  url: `${origin}/p/${pack.name}/icon-96.png?v=${icon.etag}`,
})

/** Serves the four icon files of every name at `/p/<name>/`, with an ETag, to be cached for an hour anywhere. */
export const mountPackIcons = (app: OpenAPIHono, { packIcons }: Pick<Services, 'packIcons'>) => {
  for (const [file, { type, of }] of Object.entries(FILES))
    app.get(`/p/:pack/${file}`, async (c) => {
      const name = c.req.param('pack')
      if (!NAME.test(name))
        throw new ProblemError('not_found', {
          detail: `Nothing at ${c.req.path}: a pack's name is lowercase letters, digits and dashes.`,
        })
      const set = await packIcons.at(name)
      const etag = `"${set.etag}-${file.split(/[-.]/)[1]}"`
      const headers = {
        'content-type': type,
        'cache-control': 'public, max-age=3600',
        etag,
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
        'x-content-type-options': 'nosniff',
      }
      // RFC 9110: If-None-Match compares weakly, and * matches any
      const fresh = c.req
        .header('if-none-match')
        ?.split(',')
        .some((value) => ['*', etag].includes(value.trim().replace(/^W\//, '')))
      return fresh ? c.body(null, 304, headers) : c.body(new Uint8Array(of(set)), 200, headers)
    })
}

export const iconHandlers = ({ packs, packIcons }: Services) => {
  const packOf = async (name: string) => {
    const pack = await packs.get(name)
    if (!pack) throw new ProblemError('not_found', { detail: await noPack(packs, name) })
    return pack
  }
  const answer = async (c: Context, pack: PackRow) => {
    const origin = originOf(c)
    const base = `/p/${pack.name}`
    return c.json(
      {
        ...iconView(origin, pack, await packIcons.of(pack)),
        _links: linksOf(origin, {
          self: `${PATH}/${pack.name}/icon`,
          pack: `${PATH}/${pack.name}`,
          icon96: `${base}/icon-96.png`,
          icon192: `${base}/icon-192.png`,
          icon512: `${base}/icon-512.png`,
          favicon: `${base}/favicon.ico`,
        }),
      },
      200,
    )
  }
  const upload: RouteHandler<Routes['upload']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    // Refused before it is read when it says it is bigger than any icon taken
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > 1024 * 1024)
      throw new ProblemError('payload_too_large', {
        detail: `The icon is ${Math.ceil(declared / 1024)} KB; the most is 1 MB. Send a smaller PNG or SVG (512 × 512 is plenty).`,
      })
    await packIcons.upload(pack, new Uint8Array(await c.req.arrayBuffer()))
    return answer(c, pack) as never
  }
  const recolour: RouteHandler<Routes['recolour']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    await packIcons.recolour(pack, c.req.valid('json').colour)
    return answer(c, pack) as never
  }
  const reset: RouteHandler<Routes['reset']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    await packIcons.reset(pack)
    return answer(c, pack) as never
  }
  return { upload, recolour, reset }
}
