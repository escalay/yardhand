/**
 * A Markdown document as a pack's playbooks and skill are written: the YAML block between `---` lines at its top
 * (front matter), then the text. Also the text's lines outside code blocks, which is where steps and tool names count.
 */
import { parseDocument } from 'yaml'

const BLOCK = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/
const LEADING_BLANKS = /^(?:[ \t]*\r?\n)+/

/** The text after the front matter, whatever the front matter holds. */
export const withoutFrontMatter = (markdown: string) => {
  const block = BLOCK.exec(markdown)
  return block ? markdown.slice(block[0].length).replace(LEADING_BLANKS, '') : markdown.replace(/^﻿/, '')
}

/**
 * The front matter as data (null when there is none) and the text after it, or what is wrong with the YAML and on
 * which line of the file. Values are read by YAML's core schema: text, numbers, true/false, lists and mappings.
 */
export const splitFrontMatter = (markdown: string): { data: unknown; body: string } | { problem: string } => {
  const yaml = BLOCK.exec(markdown)?.[1]
  const body = withoutFrontMatter(markdown)
  if (yaml === undefined) return { data: null, body }
  const document = parseDocument(yaml, { schema: 'core' })
  const [error] = document.errors
  try {
    if (!error) return { data: document.toJS() as unknown, body }
  } catch (thrown) {
    return {
      problem: `front matter: ${thrown instanceof Error ? thrown.message : 'not readable'}: fix the YAML between the --- lines`,
    }
  }
  // The opening `---` is the file's first line
  const line = (error?.linePos?.[0].line ?? 1) + 1
  const reason = (error?.message ?? 'not readable').split(' at line ')[0]?.replace(/[.:]$/, '')
  return { problem: `front matter, line ${line}: ${reason}: fix the YAML between the --- lines` }
}

/** The lines of a text that are not in a fenced code block. */
export const linesOutsideFences = (text: string) => {
  const kept: string[] = []
  let fence: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null
    } else if (mark) fence = mark
    else kept.push(line)
  }
  return kept
}
