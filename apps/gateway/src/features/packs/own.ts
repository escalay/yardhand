/**
 * A pack's own playbooks and its skill, as the pack's keys are served them: the only way they are read for a caller.
 * Each answer starts from the lock on the principal (`ownPlaybooks`, `skill`): what the lock does not name is never
 * looked up, so outside a pack, and for a key whose pack was removed, there is nothing to read. The pack is then
 * found by the name the lock carries, and its documents and variables by that pack's id.
 */
import { titleFromName } from '../catalog/content.js'
import { holdsOwn, type Principal } from '../clients/principals.js'
import { withoutFrontMatter } from './frontmatter.js'
import { type OwnPlaybook, parsePlaybook, renderPlaybook } from './playbook.js'
import type { PackDoc, PacksRepo } from './repo.js'
import { packSkillPathOf, SKILL_DOC, skillFile } from './skill.js'
import { variablesFrom } from './values.js'

/** A pack playbook as served, with the version of its text. */
export type ServedPlaybook = OwnPlaybook & { versionId: string }
/** A pack's skill as served: `SKILL.md` whole, its variables filled in. */
export type ServedSkill = { uri: string; path: string; versionId: string; text: string }

/** A stored playbook as it is served; one whose front matter can't be read goes under its name, with no arguments. */
const servedOf = (doc: Pick<PackDoc, 'name' | 'body' | 'versionId'>): ServedPlaybook => {
  const read = parsePlaybook(doc.name, doc.body)
  return 'problems' in read
    ? {
        name: doc.name,
        title: titleFromName(doc.name),
        description: '',
        arguments: [],
        body: withoutFrontMatter(doc.body),
        versionId: doc.versionId,
      }
    : { ...read.playbook, versionId: doc.versionId }
}

export const createPackDocs = ({ packs }: { packs: Pick<PacksRepo, 'get' | 'docsOf' | 'doc' | 'variablesOf'> }) => {
  /** The pack the principal is locked to, as stored now. */
  const packOf = (principal: Principal) => (principal.pack ? packs.get(principal.pack.name) : undefined)
  const variablesOf = async (packId: string) => variablesFrom(await packs.variablesOf(packId))

  return {
    /** The pack's own playbooks this caller is listed, in the order they were written. */
    playbooks: async (principal: Principal): Promise<ServedPlaybook[]> => {
      if (!principal.pack?.ownPlaybooks.size) return []
      const pack = await packOf(principal)
      if (!pack) return []
      return (await packs.docsOf(pack.id))
        .filter((doc) => doc.kind === 'playbook' && holdsOwn(principal, doc.name))
        .map(servedOf)
    },
    /** One of them by name, when the caller's pack wrote it. */
    playbook: async (principal: Principal, name: string): Promise<ServedPlaybook | undefined> => {
      if (!holdsOwn(principal, name)) return undefined
      const pack = await packOf(principal)
      const doc = pack && (await packs.doc(pack.id, 'playbook', name))
      return doc ? servedOf(doc) : undefined
    },
    /** A playbook's text for one use: the arguments given, then the pack's variables as they are now. */
    render: async (principal: Principal, playbook: OwnPlaybook, args: Record<string, string>) => {
      const pack = await packOf(principal)
      return renderPlaybook(playbook, args, pack ? await variablesOf(pack.id) : {})
    },
    /** The pack's skill, when it has one. */
    skill: async (principal: Principal): Promise<ServedSkill | undefined> => {
      if (!principal.pack?.skill) return undefined
      const pack = await packOf(principal)
      const doc = pack && (await packs.doc(pack.id, 'skill', SKILL_DOC))
      if (!pack || !doc) return undefined
      return {
        uri: principal.pack.skill,
        path: packSkillPathOf(pack.name),
        versionId: doc.versionId,
        text: skillFile(pack, doc.body, await variablesOf(pack.id)),
      }
    },
  }
}

export type PackDocs = ReturnType<typeof createPackDocs>
