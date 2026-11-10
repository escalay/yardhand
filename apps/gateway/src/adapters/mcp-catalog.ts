/**
 * Reads what an MCP server offers besides tools: its skills through the Skills extension (every text file, verified
 * against the server's digests), its prompts, its resource templates and listed resources. Each kind is read on its
 * own: one that fails comes back `null`, so a sync leaves it as it was instead of removing it.
 */
import type { Client } from '@modelcontextprotocol/client'
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills'
import type {
  CatalogListing,
  ManualContent,
  PlaybookContent,
  ResourceContent,
  TemplateContent,
} from '../features/catalog/content.js'

const LIST_TIMEOUT_MS = 30_000
/** How a sync reads: past the client's response cache, which keeps a list for its TTL even after the upstream redeploys. */
export const FRESH = { timeout: LIST_TIMEOUT_MS, cacheMode: 'refresh' } as const
/** Most bytes kept of one manual (all its files); a skill can be up to 16 MiB, a manual an agent reads cannot. */
const MANUAL_BYTES = 512 * 1024
const MAX_ITEMS = 500

/** Skill plumbing (`skill://…`) is served as manuals, not as links. */
const isSkillUri = (uri: string) => uri.startsWith('skill://')

const pages = async <T>(
  first: () => Promise<{ items: T[]; next?: string }>,
  next: (cursor: string) => Promise<{ items: T[]; next?: string }>,
) => {
  const found: T[] = []
  let page = await first()
  found.push(...page.items)
  while (page.next && found.length < MAX_ITEMS) {
    page = await next(page.next)
    found.push(...page.items)
  }
  return found.slice(0, MAX_ITEMS)
}

const orNull = async <T>(read: () => Promise<T>) => {
  try {
    return await read()
  } catch {
    return null
  }
}

/** Every text file of each skill, its path relative to the skill's folder. */
const manualsOf = async (client: Client): Promise<ManualContent[]> => {
  const skills = new SkillsClient(client, { skipInvalid: true })
  if (!skills.supported) return []
  const { skills: entries } = await skills.list({}, FRESH)
  const manuals: ManualContent[] = []
  for (const skill of entries.slice(0, 50)) {
    const root = skill.uri.slice(0, skill.uri.lastIndexOf('/') + 1)
    const main = await skills.read(skill, undefined, FRESH)
    const skillMd = main.text ?? new TextDecoder().decode(main.bytes)
    const files: Record<string, string> = { 'SKILL.md': skillMd }
    let bytes = skillMd.length
    const others = skill.resources === 'dynamic' ? [] : skill.resources.filter((entry) => entry.uri !== skill.uri)
    for (const entry of others) {
      if (bytes + entry.size > MANUAL_BYTES) break
      const file = await orNull(() => skills.read(skill, entry.uri, FRESH))
      // Text only: an image in a skill is for a host that renders it, not for an agent reading the manual
      if (!file?.text) continue
      const path = entry.uri.startsWith(root) ? entry.uri.slice(root.length) : entry.uri
      files[decodeURIComponent(path)] = file.text
      bytes += entry.size
    }
    manuals.push({
      kind: 'manual',
      skill: String(skill.frontmatter.name),
      description: String(skill.frontmatter.description),
      uri: skill.uri,
      files,
    })
  }
  return manuals
}

const playbooksOf = (client: Client) =>
  pages<PlaybookContent>(
    async () => {
      const page = await client.listPrompts(undefined, FRESH)
      return { items: page.prompts.map(playbookOf), next: page.nextCursor }
    },
    async (cursor) => {
      const page = await client.listPrompts({ cursor }, FRESH)
      return { items: page.prompts.map(playbookOf), next: page.nextCursor }
    },
  )

const playbookOf = (prompt: {
  name: string
  title?: string
  description?: string
  arguments?: { name: string; description?: string; required?: boolean }[]
}): PlaybookContent => ({
  kind: 'playbook',
  prompt: prompt.name,
  title: prompt.title ?? null,
  description: prompt.description ?? '',
  arguments: (prompt.arguments ?? []).map((arg) => ({
    name: arg.name,
    description: arg.description ?? null,
    required: arg.required === true,
  })),
})

const templatesOf = async (client: Client) =>
  (
    await pages<TemplateContent>(
      async () => {
        const page = await client.listResourceTemplates(undefined, FRESH)
        return { items: page.resourceTemplates.map(templateOf), next: page.nextCursor }
      },
      async (cursor) => {
        const page = await client.listResourceTemplates({ cursor }, FRESH)
        return { items: page.resourceTemplates.map(templateOf), next: page.nextCursor }
      },
    )
  ).filter((template) => !isSkillUri(template.uriTemplate))

const templateOf = (template: {
  uriTemplate: string
  name: string
  title?: string
  description?: string
  mimeType?: string
}): TemplateContent => ({
  kind: 'template',
  uriTemplate: template.uriTemplate,
  title: template.title ?? template.name ?? null,
  description: template.description ?? '',
  mimeType: template.mimeType ?? null,
})

const resourcesOf = async (client: Client) =>
  (
    await pages<ResourceContent>(
      async () => {
        const page = await client.listResources(undefined, FRESH)
        return { items: page.resources.map(resourceOf), next: page.nextCursor }
      },
      async (cursor) => {
        const page = await client.listResources({ cursor }, FRESH)
        return { items: page.resources.map(resourceOf), next: page.nextCursor }
      },
    )
  ).filter((resource) => !isSkillUri(resource.uri))

const resourceOf = (resource: {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
}): ResourceContent => ({
  kind: 'resource',
  uri: resource.uri,
  title: resource.title ?? resource.name ?? null,
  description: resource.description ?? '',
  mimeType: resource.mimeType ?? null,
})

/** What the server offers besides tools; a capability it doesn't declare is an empty list, a failed read `null`. */
export const catalogOf = async (client: Client): Promise<CatalogListing> => {
  const capabilities = client.getServerCapabilities() ?? {}
  return {
    manuals: await orNull(() => manualsOf(client)),
    playbooks: capabilities.prompts ? await orNull(() => playbooksOf(client)) : [],
    templates: capabilities.resources ? await orNull(() => templatesOf(client)) : [],
    resources: capabilities.resources ? await orNull(() => resourcesOf(client)) : [],
  }
}
