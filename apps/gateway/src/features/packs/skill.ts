/**
 * A pack's skill: one `SKILL.md`, "Working with <Title>", in six sections. The pack stores the text only; the front
 * matter and the heading are written here from the pack, so a rename or a new title never leaves them stale.
 */
import { linesOutsideFences, withoutFrontMatter } from './frontmatter.js'
import { resolveText, type Variables } from './values.js'

/** The name a pack's skill is stored under: a pack has one. */
export const SKILL_DOC = 'SKILL'

export const SKILL_SECTIONS = [
  'What it is for',
  'Which tool for which job',
  'Values already set',
  'Playbooks',
  'Gotchas',
  "What it can't do",
] as const

const plain = (heading: string) => heading.trim().toLowerCase().replaceAll('’', "'")

/** Which of the six sections a text has, as `## ` headings outside code blocks. */
export const sectionsOf = (body: string): string[] => {
  const headings = new Set(
    linesOutsideFences(body).flatMap((line) => {
      const heading = /^##[ \t]+(.+?)[ \t#]*$/.exec(line)?.[1]
      return heading ? [plain(heading)] : []
    }),
  )
  return SKILL_SECTIONS.filter((section) => headings.has(plain(section)))
}

/**
 * Where a pack's skill sits (`skill://<path>/SKILL.md`): the pack's name with runs of `-` made one and none at its
 * end, which is what the Skills extension takes as a skill's name.
 */
export const packSkillPathOf = (packName: string) => packName.replace(/-+/g, '-').replace(/-$/, '')
export const packSkillUriOf = (packName: string) => `skill://${packSkillPathOf(packName)}/SKILL.md`

/** The text of a skill as the pack stores it: without front matter and without a first `# ` heading. */
export const skillBodyOf = (markdown: string) =>
  withoutFrontMatter(markdown)
    .replace(/^(?:[ \t]*\r?\n)*#[ \t]+[^\r\n]*(?:\r?\n|$)/, '')
    .replace(/^(?:[ \t]*\r?\n)+/, '')

const DESCRIPTION_MAX = 1024

/** `SKILL.md` as it is read: front matter from the pack, the heading, then the text with the variables filled in. */
export const skillFile = (
  pack: { name: string; title: string; description: string },
  body: string,
  variables: Variables,
) => {
  const about = (pack.description.trim().split(/\r?\n[ \t]*\r?\n/)[0] ?? '').replace(/\s+/g, ' ').trim()
  const description = [...(about ? `Working with ${pack.title}: ${about}` : `Working with ${pack.title}.`)]
    .slice(0, DESCRIPTION_MAX)
    .join('')
    .trimEnd()
  return [
    '---',
    `name: ${packSkillPathOf(pack.name)}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    `# Working with ${pack.title}`,
    '',
    resolveText(body, variables).text,
  ].join('\n')
}
