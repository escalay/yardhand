/**
 * Routes for a pack's icon (owner only): upload one, give its monogram another colour, or go back to the monogram of
 * its name. The files themselves are open at the pack's address (`icon.handlers.ts`).
 */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'
import { IconColourSchema, PATH, PackIconSchema, PackName, TAG } from './routes.js'

const PNG = 'image/png'
const SVG = 'image/svg+xml'

const PackIconResource = PackIconSchema.extend({ _links: LinksSchema }).openapi('PackIconResource', {
  description: 'A pack’s icon, with links to its files.',
})
const name = PackName.openapi({ param: { name: 'name', in: 'path' } })
const answered = {
  200: { content: { [HAL_JSON]: { schema: PackIconResource } }, description: 'The icon it has now.' },
}
const binary = z.string().openapi({ format: 'binary' })
const FILES =
  'Its files are open at its address, no key needed: `/p/<name>/icon-96.png`, `icon-192.png`, `icon-512.png` and `favicon.ico`. Until the owner sets an icon there, they are the monogram of the name, alike for every name; an icon set (an upload or a colour) tells anyone who fetches them that a pack of this name exists.'

export const iconRoutes = {
  upload: createRoute({
    method: 'put',
    path: `${PATH}/{name}/icon`,
    operationId: 'setPackIcon',
    tags: [TAG],
    summary: 'Upload a pack’s icon',
    description: `Gives the pack an icon of its own, shown by MCP clients and in the app: an SVG, or a PNG of at least 96 × 96, at most 1 MB and within 4:5 of square (padded to square), sent as the body. It is drawn at 512 × 512 and kept as PNGs and a favicon; the file sent is not kept, and an SVG is never served as one. An SVG that links to anything outside itself (an image by URL, a stylesheet) is refused: nothing it names is fetched. So is an SVG with an image in it, embedded or not (send the image as a PNG), one with text, since icons are drawn with no fonts: convert its text to outlines first; and one that takes more than 10 seconds to draw. Ten uploads an hour. ${FILES}`,
    request: {
      params: z.object({ name }),
      body: {
        required: true,
        content: { [PNG]: { schema: binary }, [SVG]: { schema: binary } },
        description: 'The icon, as a PNG or an SVG file.',
      },
    },
    responses: { ...answered, ...problemResponses(400, 401, 403, 404, 413, 415, 429) },
  }),
  recolour: createRoute({
    method: 'patch',
    path: `${PATH}/{name}/icon`,
    operationId: 'recolourPackIcon',
    tags: [TAG],
    summary: 'Recolour a pack’s monogram',
    description: `Shows the monogram of the pack's name (its first letter in white) on another colour of the palette the pack lists in \`palette\`. An uploaded icon gives way to it. ${FILES}`,
    request: {
      params: z.object({ name }),
      body: {
        required: true,
        content: { 'application/json': { schema: z.object({ colour: IconColourSchema }) } },
      },
    },
    responses: { ...answered, ...problemResponses(400, 401, 403, 404) },
  }),
  reset: createRoute({
    method: 'delete',
    path: `${PATH}/{name}/icon`,
    operationId: 'resetPackIcon',
    tags: [TAG],
    summary: 'Back to the monogram',
    description:
      'Drops the icon the owner set, uploaded or recoloured: the pack shows the monogram of its name in its name’s own colour, as a pack that was never given one.',
    request: { params: z.object({ name }) },
    responses: { ...answered, ...problemResponses(401, 403, 404) },
  }),
}
