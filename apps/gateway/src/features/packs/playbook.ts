/**
 * A playbook written for a pack: Markdown whose front matter gives its title, what it is for and the arguments an
 * agent fills, and whose text writes them, and the pack's variables, as `{{name}}`. Tools are named in backticks by
 * the names the pack calls them, which is what the checks read (`checks.ts`).
 */
import { z } from 'zod'
import { type PlaybookArgument, titleFromName } from '../catalog/content.js'
import { linesOutsideFences, splitFrontMatter } from './frontmatter.js'
import { resolveText, VARIABLE, type Variables } from './values.js'

/** A pack playbook's name: lowercase words joined by `-`, so it is never a meta-tool's or the `use_pack` prompt's. */
export const PLAYBOOK_NAME = /^[a-z][a-z0-9-]{2,63}$/
/** About how many steps one playbook holds before it reads better as two. */
export const MAX_STEPS = 12

export type OwnPlaybook = {
  name: string
  title: string
  description: string
  arguments: PlaybookArgument[]
  /** The text after the front matter, `{{name}}` not yet filled in. */
  body: string
}

const FrontMatter = z
  .object({
    title: z.string().max(120).optional(),
    description: z.string().max(1024).optional(),
    arguments: z
      .array(
        z.object({ name: z.string(), description: z.string().max(400).nullish(), required: z.boolean().optional() }),
      )
      .max(20)
      .optional(),
  })
  .passthrough()

const kindOf = (value: unknown) =>
  Array.isArray(value)
    ? 'a list'
    : value === null || value === undefined
      ? 'empty'
      : typeof value === 'object'
        ? 'a mapping'
        : typeof value === 'string'
          ? 'text'
          : typeof value === 'boolean'
            ? 'true or false'
            : 'a number'

const WRITTEN_AS: Record<string, string> = {
  string: 'text',
  boolean: 'true or false',
  array: 'a list, one `- name: …` per argument',
  object: 'keys, like `name: guest`',
}

const at = (data: unknown, path: PropertyKey[]) =>
  path.reduce<unknown>(
    (value, key) => (value && typeof value === 'object' ? (value as Record<PropertyKey, unknown>)[key] : undefined),
    data,
  )

/** One thing the front matter's shape gets wrong, as a sentence that says what to write instead. */
const saidOf = (data: unknown, issue: z.core.$ZodIssue) => {
  const where = issue.path.join('.')
  if (issue.code === 'invalid_type') {
    if (issue.path.at(-1) === 'name' && at(data, issue.path) === undefined)
      return `${issue.path.slice(0, -1).join('.')} has no name: give it one, like \`name: guest\``
    return `${where} is ${kindOf(at(data, issue.path))}: write it as ${WRITTEN_AS[issue.expected] ?? issue.expected}`
  }
  if (issue.code === 'too_big')
    return `${where} is too long: ${issue.maximum} ${issue.origin === 'array' ? 'arguments' : 'characters'} at most`
  return `${where}: ${issue.message}`
}

/**
 * A playbook read from its Markdown, or everything wrong with its front matter. Without front matter it is titled
 * after its name and takes no arguments.
 */
export const parsePlaybook = (name: string, markdown: string): { playbook: OwnPlaybook } | { problems: string[] } => {
  const split = splitFrontMatter(markdown)
  if ('problem' in split) return { problems: [split.problem] }
  if (split.data !== null && (typeof split.data !== 'object' || Array.isArray(split.data)))
    return { problems: [`front matter is ${kindOf(split.data)}: write it as keys, like \`title: Say hello\``] }
  const read = FrontMatter.safeParse(split.data ?? {})
  if (!read.success) return { problems: read.error.issues.map((issue) => saidOf(split.data, issue)) }
  const declared = read.data.arguments ?? []
  const seen = new Set<string>()
  const problems = declared.flatMap((argument) => {
    if (!VARIABLE.test(argument.name))
      return [
        `${argument.name} is not an argument name: start with a lowercase letter, then lowercase letters, digits or _ (40 at most), like guest_name`,
      ]
    if (seen.has(argument.name)) return [`${argument.name} is an argument twice: keep one`]
    seen.add(argument.name)
    return []
  })
  if (problems.length) return { problems }
  return {
    playbook: {
      name,
      title: read.data.title?.trim() || titleFromName(name),
      description: read.data.description?.trim() ?? '',
      arguments: declared.map((argument) => ({
        name: argument.name,
        description: argument.description ?? null,
        required: argument.required ?? false,
      })),
      body: split.body,
    },
  }
}

/** How many steps a text has: its numbered items at no indent, outside code blocks. */
export const stepsIn = (body: string) => linesOutsideFences(body).filter((line) => /^\d+[.)]\s/.test(line)).length

/** What a text writes in single backticks, each once, in order: where a tool is named. Code blocks are not read. */
export const toolRefsIn = (text: string) => [
  ...new Set(
    [
      ...linesOutsideFences(text)
        .join('\n')
        .matchAll(/(?<!`)`([^`\n]+)`(?!`)/g),
    ]
      .map((match) => (match[1] ?? '').trim())
      .filter(Boolean),
  ),
]

/**
 * The playbook's text for one use: its arguments filled with what the agent gave (nothing for one left out), then
 * the pack's variables. A value filled in is never read for placeholders again.
 */
export const renderPlaybook = (playbook: OwnPlaybook, given: Record<string, string>, variables: Variables) =>
  resolveText(playbook.body, {
    ...variables,
    ...Object.fromEntries(playbook.arguments.map((argument) => [argument.name, given[argument.name] ?? ''])),
  }).text
