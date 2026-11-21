/**
 * Handlers for what is written for a pack (owner only): its own playbooks and its skill. Every save is judged first
 * (`checks.ts`), with the document it sends as the one place touched, and notes the tool versions the text stands on.
 */
import type { RouteHandler } from '@hono/zod-openapi'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { titleFromName } from '../catalog/content.js'
import { requireOwner } from '../clients/principals.js'
import { basedOnOf, checkPack, type Finding, judge, throwOnRefused } from './checks.js'
import { type DocFlag, docFlagOf } from './flags.js'
import { noPack } from './names.js'
import type { ownRoutes } from './own.routes.js'
import { parsePlaybook, stepsIn } from './playbook.js'
import type { PackContents, PackDoc } from './repo.js'
import { PATH } from './routes.js'
import type { PackDocKind, PackDocVersionRow, PackRow } from './schema.js'
import { packSkillUriOf, SKILL_DOC, sectionsOf, skillBodyOf, skillFile } from './skill.js'
import { packStateOf, withDoc } from './state.js'
import { variablesFrom } from './values.js'

type Routes = typeof ownRoutes

/** Where the checks file a document's findings. */
export const docPathOf = (kind: PackDocKind, name: string) => (kind === 'skill' ? 'skill' : `playbooks.${name}`)

/** Findings as they are returned: without the stored key and the tool they sit in. */
export const shownFindings = (findings: Finding[]) =>
  findings.map(({ level, code, path, message }) => ({ level, code, path, message }))

const flagShown = (flag: DocFlag | null) => (flag ? { was: flag.was, now: flag.now } : null)

/** A playbook's stored text as the pack shows it; one whose front matter can't be read is titled after its name. */
const playbookShown = (doc: Pick<PackDoc, 'name' | 'body'>) => {
  const read = parsePlaybook(doc.name, doc.body)
  return 'problems' in read
    ? { name: doc.name, title: titleFromName(doc.name), description: '', arguments: [], steps: 0 }
    : {
        name: doc.name,
        title: read.playbook.title,
        description: read.playbook.description,
        arguments: read.playbook.arguments,
        steps: stepsIn(read.playbook.body),
      }
}

/** The flag on each of a pack's documents, by where the checks file it; null for one that stands. */
export const docFlagsOf = async (tools: Services['tools'], pack: PackRow, held: PackContents) =>
  new Map(
    await Promise.all(
      held.docs.map(
        async (doc) => [docPathOf(doc.kind, doc.name), await docFlagOf(tools, pack, doc.basedOn, held.tools)] as const,
      ),
    ),
  )

/** What is written for a pack, as its answer shows it: each playbook and the skill with its own findings and flag. */
export const ownOf = (pack: PackRow, held: PackContents, flags: Map<string, DocFlag | null>, findings: Finding[]) => {
  const partOf = (doc: PackDoc) => {
    const path = docPathOf(doc.kind, doc.name)
    return {
      flag: flagShown(flags.get(path) ?? null),
      findings: shownFindings(findings.filter((finding) => finding.path === path)),
    }
  }
  const skill = held.docs.find((doc) => doc.kind === 'skill')
  return {
    ownPlaybooks: held.docs
      .filter((doc) => doc.kind === 'playbook')
      .map((doc) => ({ ...playbookShown(doc), ...partOf(doc) })),
    skill: skill ? { uri: packSkillUriOf(pack.name), sections: sectionsOf(skill.body), ...partOf(skill) } : null,
  }
}

export const ownHandlers = ({ packs, tools, catalog, upstreams, listsChanged }: Services) => {
  const repos = { packs, tools, catalog, upstreams }
  const packOf = async (name: string) => {
    const pack = await packs.get(name)
    if (!pack) throw new ProblemError('not_found', { detail: await noPack(packs, name) })
    return pack
  }
  const playbooksPath = (pack: PackRow) => `${PATH}/${pack.name}/playbooks`
  const noPlaybook = (pack: PackRow, name: string) =>
    new ProblemError('not_found', {
      detail: `${pack.title} has no playbook of its own called ${name}. GET ${playbooksPath(pack)} lists them; POST there makes one.`,
    })
  const noSkill = (pack: PackRow) =>
    new ProblemError('not_found', {
      detail: `${pack.title} has no skill yet: PUT ${PATH}/${pack.name}/skill writes it.`,
    })

  /** The pack as stored, with what the checks find in it. */
  const read = async (pack: PackRow) => {
    const held = await packs.contentsOf(pack)
    const flags = await docFlagsOf(tools, pack, held)
    return { held, own: ownOf(pack, held, flags, checkPack(await packStateOf(repos, pack, held))) }
  }

  /** The text of one version (the served one when none is asked for) and the list of them, newest first. */
  const versionsOf = async (pack: PackRow, doc: PackDoc, asked: string | undefined, what: string, self: string) => {
    const rows = await packs.docVersions(pack.id, doc.kind, doc.name)
    const shown: Pick<PackDocVersionRow, 'id' | 'body'> | undefined =
      asked === undefined
        ? { id: doc.versionId, body: doc.body }
        : await packs.docVersion(pack.id, doc.kind, doc.name, asked)
    if (!shown)
      throw new ProblemError('not_found', {
        detail: `${what} has no version ${asked}. GET ${self} lists its versions.`,
      })
    return {
      markdown: shown.body,
      version: shown.id,
      versions: rows.map((row) => ({
        id: row.id,
        source: row.source,
        createdAt: row.createdAt,
        live: row.id === doc.versionId,
      })),
      updatedAt: doc.updatedAt,
    }
  }

  const playbookDetail = async (origin: string, pack: PackRow, name: string, asked?: string) => {
    const { held, own } = await read(pack)
    const doc = held.docs.find((other) => other.kind === 'playbook' && other.name === name)
    const shown = own.ownPlaybooks.find((playbook) => playbook.name === name)
    if (!doc || !shown) throw noPlaybook(pack, name)
    const self = `${playbooksPath(pack)}/${name}`
    return {
      ...shown,
      ...(await versionsOf(pack, doc, asked, name, self)),
      _links: linksOf(origin, { self, playbooks: playbooksPath(pack), pack: `${PATH}/${pack.name}` }),
    }
  }

  const skillDetail = async (origin: string, pack: PackRow, asked?: string) => {
    const { held, own } = await read(pack)
    const doc = held.docs.find((other) => other.kind === 'skill')
    if (!doc || !own.skill) throw noSkill(pack)
    const self = `${PATH}/${pack.name}/skill`
    const text = await versionsOf(pack, doc, asked, `${pack.title}’s skill`, self)
    return {
      ...own.skill,
      ...text,
      served: skillFile(pack, text.markdown, variablesFrom(held.variables)),
      _links: linksOf(origin, { self, pack: `${PATH}/${pack.name}` }),
    }
  }

  /** Judges the pack with this text in it, refuses what the text gets wrong, then saves it as the newest version. */
  const save = async (pack: PackRow, kind: PackDocKind, name: string, markdown: string) => {
    const before = await packStateOf(repos, pack)
    const body = kind === 'skill' ? skillBodyOf(markdown) : markdown
    const after = withDoc(before, kind, name, body)
    const path = docPathOf(kind, name)
    throwOnRefused(judge(before, after, [path]).refused)
    await packs.saveDoc(pack.id, kind, name, { body, basedOn: basedOnOf(after, path), source: 'owner' })
    listsChanged({ prompts: true, resources: true })
  }

  const listPlaybooks: RouteHandler<Routes['listPlaybooks']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    const { own } = await read(pack)
    return c.json(
      {
        count: own.ownPlaybooks.length,
        _links: linksOf(originOf(c), { self: playbooksPath(pack), pack: `${PATH}/${pack.name}` }),
        _embedded: { playbooks: own.ownPlaybooks },
      },
      200,
    )
  }

  const createPlaybook: RouteHandler<Routes['createPlaybook']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    const { name, markdown } = c.req.valid('json')
    if (await packs.doc(pack.id, 'playbook', name))
      throw new ProblemError('conflict', {
        detail: `${pack.title} already has a playbook called ${name}: PUT ${playbooksPath(pack)}/${name} replaces its text.`,
      })
    await save(pack, 'playbook', name, markdown)
    return c.json(await playbookDetail(originOf(c), pack, name), 201, { location: `${playbooksPath(pack)}/${name}` })
  }

  const getPlaybook: RouteHandler<Routes['getPlaybook']> = async (c) => {
    requireOwner(c)
    const { name, playbook } = c.req.valid('param')
    return c.json(await playbookDetail(originOf(c), await packOf(name), playbook, c.req.valid('query').version), 200)
  }

  const setPlaybook: RouteHandler<Routes['setPlaybook']> = async (c) => {
    requireOwner(c)
    const { name, playbook } = c.req.valid('param')
    const pack = await packOf(name)
    if (!(await packs.doc(pack.id, 'playbook', playbook))) throw noPlaybook(pack, playbook)
    await save(pack, 'playbook', playbook, c.req.valid('json').markdown)
    return c.json(await playbookDetail(originOf(c), pack, playbook), 200)
  }

  const removePlaybook: RouteHandler<Routes['removePlaybook']> = async (c) => {
    requireOwner(c)
    const { name, playbook } = c.req.valid('param')
    const pack = await packOf(name)
    if (!(await packs.removeDoc(pack.id, 'playbook', playbook))) throw noPlaybook(pack, playbook)
    listsChanged({ prompts: true, resources: true })
    return c.body(null, 204)
  }

  const getSkill: RouteHandler<Routes['getSkill']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    return c.json(await skillDetail(originOf(c), pack, c.req.valid('query').version), 200)
  }

  const setSkill: RouteHandler<Routes['setSkill']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    await save(pack, 'skill', SKILL_DOC, c.req.valid('json').markdown)
    return c.json(await skillDetail(originOf(c), pack), 200)
  }

  const removeSkill: RouteHandler<Routes['removeSkill']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    if (!(await packs.removeDoc(pack.id, 'skill', SKILL_DOC))) throw noSkill(pack)
    listsChanged({ resources: true })
    return c.body(null, 204)
  }

  const check: RouteHandler<Routes['check']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    const draft = c.req.valid('json')
    const state = await packStateOf(repos, pack)
    const taken = new Set([...state.playbooks.map((doc) => doc.name), ...state.heldPlaybooks])
    // A draft with no name yet is checked under one the pack has no playbook of
    const free = ['draft', ...Array.from({ length: taken.size + 1 }, (_, count) => `draft-${count + 2}`)].find(
      (candidate) => !taken.has(candidate),
    )
    const name = draft.kind === 'skill' ? SKILL_DOC : (draft.name ?? free ?? 'draft')
    const path = docPathOf(draft.kind, name)
    const after = withDoc(
      state,
      draft.kind,
      name,
      draft.kind === 'skill' ? skillBodyOf(draft.markdown) : draft.markdown,
    )
    return c.json(
      {
        findings: shownFindings(checkPack(after).filter((finding) => finding.path === path)),
        _links: linksOf(originOf(c), { self: `${PATH}/${pack.name}/checks`, pack: `${PATH}/${pack.name}` }),
      },
      200,
    )
  }

  return {
    listPlaybooks,
    createPlaybook,
    getPlaybook,
    setPlaybook,
    removePlaybook,
    getSkill,
    setSkill,
    removeSkill,
    check,
  }
}
