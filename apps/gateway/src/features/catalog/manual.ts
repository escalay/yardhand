/**
 * A manual as agents read it through the gateway: the upstream's `SKILL.md` exactly as written, with a short note
 * after its frontmatter saying how its tools and links are reached here. The note is the only change, so what the
 * owner reviews is what the upstream sent.
 */
import type { ManualContent } from './content.js'

/** `cookbook://recipes/{id}` → `cookbook`; skill plumbing and plain web links name no scheme of their own. */
export const schemeOf = (uriOrTemplate: string) => {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(uriOrTemplate)
  const scheme = match?.[1]?.toLowerCase()
  return scheme && !['http', 'https', 'skill', 'file'].includes(scheme) ? scheme : null
}

export const noteFor = ({
  upstreamId,
  exampleTool,
  linkSchemes,
}: {
  upstreamId: string
  /** A live tool of this upstream as the upstream names it, e.g. `research_recipes`. */
  exampleTool: string | null
  linkSchemes: string[]
}) =>
  [
    `> Through Yardhand: this server's tools are named \`${upstreamId}.<tool>\`${exampleTool ? ` (so \`${exampleTool}\` is \`${upstreamId}.${exampleTool}\`)` : ''}.`,
    '> Run them with `call_tool`, or call them directly when they are pinned.',
    linkSchemes.length
      ? `> Links it returns (${linkSchemes.map((scheme) => `\`${scheme}://…\``).join(', ')}) are read with \`read_resource\`, as they are.`
      : null,
  ]
    .filter(Boolean)
    .join('\n')

const FRONTMATTER = /^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/

/** `SKILL.md` with the note after its frontmatter (or at the top when it has none). */
export const withNote = (skillMd: string, note: string) => {
  const front = FRONTMATTER.exec(skillMd)?.[0]
  if (!front) return `${note}\n\n${skillMd}`
  return `${front}\n${note}\n\n${skillMd.slice(front.length).replace(/^\r?\n/, '')}`
}

/** Every file of the manual as agents get it: `SKILL.md` noted, the rest as written. */
export const agentFilesOf = (manual: ManualContent, note: string): Record<string, string> => ({
  ...manual.files,
  'SKILL.md': withNote(manual.files['SKILL.md'] ?? '', note),
})
