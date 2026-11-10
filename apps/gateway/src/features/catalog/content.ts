/** What each kind of catalog item holds, how it is named for agents, and how a version is hashed and shown. */
import { createHash } from 'node:crypto'
import type { CatalogKind } from './schema.js'

export type PlaybookArgument = { name: string; description: string | null; required: boolean }

export type ManualContent = {
  kind: 'manual'
  /** The skill's own name, from its frontmatter. */
  skill: string
  description: string
  /** The upstream's URI for its `SKILL.md`. */
  uri: string
  /** Every text file of the skill by its path inside the skill (`SKILL.md`, `references/flows.md`). */
  files: Record<string, string>
}
export type PlaybookContent = {
  kind: 'playbook'
  prompt: string
  title: string | null
  description: string
  arguments: PlaybookArgument[]
}
export type TemplateContent = {
  kind: 'template'
  uriTemplate: string
  title: string | null
  description: string
  mimeType: string | null
}
export type ResourceContent = {
  kind: 'resource'
  uri: string
  title: string | null
  description: string
  mimeType: string | null
}
export type CatalogContent = ManualContent | PlaybookContent | TemplateContent | ResourceContent

/** What one sync found; a kind left `null` could not be read this time and is left as it was. */
export type CatalogListing = {
  manuals: ManualContent[] | null
  playbooks: PlaybookContent[] | null
  templates: TemplateContent[] | null
  resources: ResourceContent[] | null
}

export const EMPTY_LISTING: CatalogListing = { manuals: [], playbooks: [], templates: [], resources: [] }

const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
        )
      : value

export const hashContent = (content: CatalogContent) =>
  createHash('sha256')
    .update(JSON.stringify(stable(content)))
    .digest('hex')

const SAFE = /[^A-Za-z0-9_.-]+/g

/** The upstream's own name for the item: the key a sync matches versions by. */
export const remoteNameOf = (content: CatalogContent) =>
  content.kind === 'manual'
    ? content.skill
    : content.kind === 'playbook'
      ? content.prompt
      : content.kind === 'template'
        ? content.uriTemplate
        : content.uri

/**
 * The name agents use: `cookbook` for the manual named after its upstream (`notes.field-guide` otherwise),
 * `cookbook-plan-a-dinner` for a playbook (a slash command reads `/mcp__gw__cookbook-plan-a-dinner`).
 */
export const publicNameOf = (upstreamId: string, content: CatalogContent) => {
  const remote = remoteNameOf(content)
  if (content.kind === 'manual')
    return content.skill === upstreamId ? upstreamId : `${upstreamId}.${remote.replace(SAFE, '-')}`
  if (content.kind === 'playbook') return `${upstreamId}-${remote.replace(SAFE, '-')}`.slice(0, 128)
  return `${upstreamId}:${remote}`
}

export const itemIdOf = (upstreamId: string, kind: CatalogKind, remoteName: string) =>
  `${kind}:${upstreamId}:${remoteName}`

/** `plan-a-dinner` → `Plan a dinner`, for playbooks that bring no title of their own. */
export const titleFromName = (name: string) => {
  const words = name.replace(/[-_]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name
}

/** `Cookbook · Plan a dinner`: how clients that show titles list a playbook, short enough for a menu. */
export const playbookTitleOf = (upstreamId: string, content: PlaybookContent) =>
  `${titleFromName(upstreamId)} · ${content.title ?? titleFromName(content.prompt)}`

/**
 * Where a manual sits as a skill (`skill://<path>/SKILL.md`): the Skills extension wants the last segment to be the
 * skill's own name, so `cookbook` for cookbook's `cookbook`, `guides/baking` for guides' `baking`.
 */
export const skillPathOf = (upstreamId: string, content: ManualContent) =>
  content.skill === upstreamId ? upstreamId : `${upstreamId}/${content.skill}`

/** A version as text, for reviewing it beside the live one and for search. */
export const textOf = (content: CatalogContent): { title: string | null; description: string; body: string } => {
  if (content.kind === 'manual') {
    const others = Object.entries(content.files)
      .filter(([path]) => path !== 'SKILL.md')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, text]) => `\n\n--- ${path} ---\n\n${text}`)
    return {
      title: content.skill,
      description: content.description,
      body: `${content.files['SKILL.md'] ?? ''}${others.join('')}`,
    }
  }
  if (content.kind === 'playbook')
    return {
      title: content.title,
      description: content.description,
      body: content.arguments.length
        ? content.arguments
            .map(
              (arg) =>
                `${arg.name}${arg.required ? ' (required)' : ''}${arg.description ? `: ${arg.description}` : ''}`,
            )
            .join('\n')
        : 'No arguments.',
    }
  if (content.kind === 'template')
    return {
      title: content.title,
      description: content.description,
      body: `${content.uriTemplate}${content.mimeType ? `\n${content.mimeType}` : ''}`,
    }
  return {
    title: content.title,
    description: content.description,
    body: `${content.uri}${content.mimeType ? `\n${content.mimeType}` : ''}`,
  }
}
