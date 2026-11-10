/** Pure rules for agents: the key put into a snippet, and an agent's reach in words. */
import type { Client } from '@/api/client'

/** A snippet with the key in place of the placeholder, when the key is known (right after making it). */
export const withKey = (snippet: string, placeholder: string, key: string | null) =>
  key ? snippet.replaceAll(placeholder, key) : snippet

const packsLine = (pack: string, packs: string[]) =>
  packs.length > 1 ? `${packs.length} packs (${pack} by default)` : `The ${pack} pack`

export const reachOf = (client: Pick<Client, 'upstreams' | 'scope'> & Partial<Pick<Client, 'pack' | 'packs'>>) =>
  `${client.pack ? packsLine(client.pack, client.packs ?? []) : client.upstreams === 'all' ? 'Every connection' : `${client.upstreams.length} connection${client.upstreams.length === 1 ? '' : 's'}`}, ${
    client.scope === 'write' ? 'reads and changes' : 'reads only'
  }`

/** The packs a key opens and its default after ticking or unticking one: the default moves only when it goes. */
export const pickPack = (
  current: { packs: string[]; pack: string },
  name: string,
  on: boolean,
): { packs: string[]; pack: string } => {
  const packs = on ? [...new Set([...current.packs, name])] : current.packs.filter((other) => other !== name)
  const pack = packs.includes(current.pack) ? current.pack : (packs[0] ?? '')
  return { packs, pack }
}

/** Where an agent runs → the setup tab to open first. */
export const SURFACE_FOR = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
  'claude-ai': 'claude.ai',
  curl: 'A script or curl',
  typescript: 'TypeScript',
} as const

export type SurfaceId = keyof typeof SURFACE_FOR

/** "9 of 11", flagged when an agent mostly doesn't find what it searches for; "–" before it searched. */
export const foundOf = ({ searches7d, found7d }: { searches7d: number; found7d: number }) =>
  searches7d
    ? { text: `${found7d} of ${searches7d}`, struggling: searches7d >= 3 && found7d / searches7d < 0.5 }
    : { text: '–', struggling: false }
