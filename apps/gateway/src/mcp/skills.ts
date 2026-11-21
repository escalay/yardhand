/**
 * Skills through the MCP Skills extension (SEP-2640), for the caller: each manual its client may read is a skill at
 * `skill://<path>/SKILL.md` (`skill://cookbook/SKILL.md`, `skill://guides/baking/SKILL.md`), its files as agents read
 * them (the gateway's note in `SKILL.md`). Reading a `SKILL.md` is logged as a manual read; its other files are not
 * logged on their own.
 *
 * A pack connection lists the pack's own skill first, at `skill://<pack>/SKILL.md`. It wins that address: a manual
 * the pack holds that would sit there too is left out of the list, and is still read as a manual
 * (`gateway://u/<upstream>/manual`).
 */
import { createHash } from 'node:crypto'
import type { Skill, SkillReadResult } from '@modelcontextprotocol/server/ext/skills'
import { SkillsExtension, skillEntry } from '@modelcontextprotocol/server/ext/skills'
import { type ManualContent, skillPathOf } from '../features/catalog/content.js'
import { holds, type Principal } from '../features/clients/principals.js'
import type { ServedSkill } from '../features/packs/own.js'
import type { Services } from '../services.js'

/** Entries by manual version and note: building one hashes every file, so it is done once per change. */
const entries = new Map<string, Skill>()
const kept = (key: string, entry: Skill) => {
  if (entries.size > 200) entries.clear()
  entries.set(key, entry)
  return entry
}

export const manualSkills = (
  { catalog, reads, packDocs }: Pick<Services, 'catalog' | 'reads' | 'packDocs'>,
  principal: Principal,
) => {
  const entryOf = async (name: string) => {
    const found = await reads.manualFiles(principal, name)
    if (!found) return undefined
    const key = `${found.item.versionId}:${found.note}`
    const cached = entries.get(key)
    if (cached) return cached
    return kept(
      key,
      await skillEntry(skillPathOf(found.item.upstreamId, found.item.content as ManualContent), found.files),
    )
  }
  /**
   * The pack's own skill as an entry, kept by its text: the text follows the pack's variables, title and words, so
   * a version id would serve a stale digest. One the extension can't take is left out, and still read by address.
   */
  const ownEntryOf = async (skill: ServedSkill) => {
    const key = `own:${skill.path}:${createHash('sha256').update(skill.text).digest('hex')}`
    const cached = entries.get(key)
    if (cached) return cached
    const entry = await skillEntry(skill.path, { 'SKILL.md': skill.text }).catch(() => undefined)
    return entry && kept(key, entry)
  }
  return new SkillsExtension({
    // A manual changes when its upstream does: let clients cache the list a few minutes, no longer
    cacheHint: { ttlMs: 5 * 60_000, cacheScope: 'private' },
    onWarning: () => {},
    source: {
      list: async () => {
        const own = await packDocs.skill(principal)
        const manuals = (await catalog.listLive({ kinds: ['manual'], upstreams: principal.upstreams })).filter(
          (item) => holds(principal, item) && skillPathOf(item.upstreamId, item.content as ManualContent) !== own?.path,
        )
        const listed = await Promise.all([
          own ? ownEntryOf(own) : undefined,
          ...manuals.map((item) => entryOf(item.name)),
        ])
        return { skills: listed.filter((entry): entry is Skill => Boolean(entry)) }
      },
      get: async (uri) => {
        const target = await reads.skillTarget(principal, uri)
        if (!target) return undefined
        if ('own' in target) {
          const own = await packDocs.skill(principal)
          return own && ownEntryOf(own)
        }
        return target.file === 'SKILL.md' ? entryOf(target.name) : undefined
      },
      read: async (uri): Promise<SkillReadResult | undefined> => {
        const target = await reads.skillTarget(principal, uri)
        if (!target) return undefined
        if ('own' in target) {
          const read = await reads.packSkill({ principal, via: 'mcp' }).catch(() => undefined)
          return read && { text: read.text, mimeType: 'text/markdown' }
        }
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
