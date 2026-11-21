/**
 * The message an owner sends the person a pack is shared with. The key is in the text, because the owner sends it on;
 * it is built here so the app, a script and an agent hand out the same words.
 */
import { dayOf } from '../clients/lifetimes.js'
import { type APP_IDS, KEY_PLACEHOLDER, surfacesOf } from '../clients/setup.js'

/** What the pack is, what they can do, until when, and the setup for their app with the key in place. */
export const shareMessage = ({
  pack,
  person,
  scope,
  expiresAt,
  app,
  origin,
  key,
}: {
  pack: { name: string; title: string; description: string }
  person: string
  scope: 'read' | 'write'
  expiresAt: string | null
  /** Where they will paste the key; null when not known. An app with no setup at a pack's address reads as null. */
  app: (typeof APP_IDS)[number] | null
  origin: string
  key: string
}): string => {
  const surface = surfacesOf({ origin, kind: 'key', oauth: false, pack: pack.name }).find((one) => one.id === app)
  const keyed = (text: string) => text.replaceAll(KEY_PLACEHOLDER, key)
  const [purpose] = pack.description.trim().split(/\n\s*\n/)
  const access =
    scope === 'write' ? 'You can read and change things with it.' : 'You can read with it, but not change anything.'
  const setup = surface
    ? [
        `Add it to ${surface.title} (${surface.where.charAt(0).toLowerCase()}${surface.where.slice(1)}):`,
        keyed(surface.snippet),
        ...(surface.note ? [keyed(surface.note)] : []),
      ]
    : [
        `Its address is ${origin}/p/${pack.name}/mcp and your key is ${key}. Add it to your app as an MCP server and send the key as a bearer token: Authorization: Bearer ${key}`,
      ]
  return [
    `Hi ${person}, I'm sharing ${pack.title} with you.`,
    ...(purpose ? [purpose] : []),
    `${access} It works until ${expiresAt ? dayOf(expiresAt) : 'I end it'}.`,
    ...setup,
    'The key is yours alone: keep it to yourself. When it stops working, ask me for a new invite.',
  ].join('\n\n')
}
