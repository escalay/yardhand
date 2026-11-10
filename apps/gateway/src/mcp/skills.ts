/**
 * Manuals through the MCP Skills extension (SEP-2640), for the caller: each manual its client may read is a skill at
 * `skill://<path>/SKILL.md` (`skill://cookbook/SKILL.md`, `skill://guides/baking/SKILL.md`), its files as agents read
 * them (the gateway's note in `SKILL.md`). Reading a `SKILL.md` is logged as a manual read; its other files are not
 * logged on their own.
 */
import type { Skill, SkillReadResult } from '@modelcontextprotocol/server/ext/skills'
import { SkillsExtension, skillEntry } from '@modelcontextprotocol/server/ext/skills'
import { type ManualContent, skillPathOf } from '../features/catalog/content.js'
import { holds, type Principal } from '../features/clients/principals.js'
import type { Services } from '../services.js'

/** Entries by manual version and note: building one hashes every file, so it is done once per change. */
const entries = new Map<string, Skill>()

export const manualSkills = ({ catalog, reads }: Pick<Services, 'catalog' | 'reads'>, principal: Principal) => {
  const entryOf = async (name: string) => {
    const found = await reads.manualFiles(principal, name)
    if (!found) return undefined
    const key = `${found.item.versionId}:${found.note}`
    const cached = entries.get(key)
    if (cached) return cached
    const entry = await skillEntry(skillPathOf(found.item.upstreamId, found.item.content as ManualContent), found.files)
    if (entries.size > 200) entries.clear()
    entries.set(key, entry)
    return entry
  }
  return new SkillsExtension({
    // A manual changes when its upstream does: let clients cache the list a few minutes, no longer
    cacheHint: { ttlMs: 5 * 60_000, cacheScope: 'private' },
    onWarning: () => {},
    source: {
      list: async () => {
        const manuals = (await catalog.listLive({ kinds: ['manual'], upstreams: principal.upstreams })).filter((item) =>
          holds(principal, item),
        )
        const skills = (await Promise.all(manuals.map((item) => entryOf(item.name)))).filter((entry): entry is Skill =>
          Boolean(entry),
        )
        return { skills }
      },
      get: async (uri) => {
        const target = await reads.skillTarget(principal, uri)
        return target?.file === 'SKILL.md' ? entryOf(target.name) : undefined
      },
      read: async (uri): Promise<SkillReadResult | undefined> => {
        const target = await reads.skillTarget(principal, uri)
        if (!target) return undefined
        if (target.file === 'SKILL.md') {
          const read = await reads.manual({ principal, via: 'mcp' }, target.name).catch(() => undefined)
          return read ? { text: read.files['SKILL.md'] ?? '', mimeType: 'text/markdown' } : undefined
        }
        const found = await reads.manualFiles(principal, target.name)
        const text = found?.files[target.file]
        return text === undefined ? undefined : { text, mimeType: 'text/markdown' }
      },
    },
  })
}
