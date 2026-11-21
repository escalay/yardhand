import { describe, expect, it } from 'vitest'
import { splitFrontMatter } from './frontmatter.js'
import { parsePlaybook, renderPlaybook, stepsIn, toolRefsIn } from './playbook.js'

const SAY_HELLO = `---
title: Say hello
description: "Greets a guest: by name, from the desk."
arguments:
  - name: guest
    description: Who to greet.
    required: true
  - name: tone
---

Greet {{guest}} from {{desk}}.

1. Run \`greet_from_desk\` with \`to\` set to {{guest}}.
2. Say it back with \`fixture.echo\`.
`

const parsed = (markdown: string) => {
  const read = parsePlaybook('say-hello', markdown)
  if ('problems' in read) throw new Error(read.problems.join('; '))
  return read.playbook
}
const problemsOf = (markdown: string) => {
  const read = parsePlaybook('say-hello', markdown)
  return 'problems' in read ? read.problems : []
}

describe('splitFrontMatter', () => {
  it('splits the leading block from the text, with a byte order mark and Windows line ends', () => {
    expect(splitFrontMatter('﻿---\r\ntitle: Say hello\r\n---\r\n\r\nGreet them.\r\n')).toEqual({
      data: { title: 'Say hello' },
      body: 'Greet them.\r\n',
    })
  })

  it('leaves a text without front matter as it is', () => {
    expect(splitFrontMatter('Greet them.\n\n---\n\nThen stop.')).toEqual({
      data: null,
      body: 'Greet them.\n\n---\n\nThen stop.',
    })
  })

  it('says which line of the file the YAML fails on', () => {
    const read = splitFrontMatter('---\ntitle: Say hello\narguments: [guest\n---\nGreet them.')
    expect(read).toEqual({
      problem: expect.stringMatching(/^front matter, line [34]: .+: fix the YAML between the --- lines$/),
    })
  })

  it('reads values as plain YAML: no tags, and a date stays text', () => {
    expect(splitFrontMatter('---\ntitle: 2026-01-05\nrequired: yes\n---\n')).toEqual({
      data: { title: '2026-01-05', required: 'yes' },
      body: '',
    })
  })
})

describe('parsePlaybook', () => {
  it('reads the title, the description and the arguments from the front matter', () => {
    expect(parsed(SAY_HELLO)).toEqual({
      name: 'say-hello',
      title: 'Say hello',
      description: 'Greets a guest: by name, from the desk.',
      arguments: [
        { name: 'guest', description: 'Who to greet.', required: true },
        { name: 'tone', description: null, required: false },
      ],
      body: 'Greet {{guest}} from {{desk}}.\n\n1. Run `greet_from_desk` with `to` set to {{guest}}.\n2. Say it back with `fixture.echo`.\n',
    })
  })

  it('titles a playbook without front matter after its name', () => {
    expect(parsed('Greet them.')).toEqual({
      name: 'say-hello',
      title: 'Say hello',
      description: '',
      arguments: [],
      body: 'Greet them.',
    })
  })

  it('refuses front matter that is not a mapping', () => {
    expect(problemsOf('---\n- guest\n- tone\n---\nGreet them.')).toEqual([
      'front matter is a list: write it as keys, like `title: Say hello`',
    ])
  })

  it('refuses an argument without a name, a bad name and one named twice', () => {
    expect(problemsOf('---\narguments:\n  - description: Who to greet.\n---\n')).toEqual([
      'arguments.0 has no name: give it one, like `name: guest`',
    ])
    expect(problemsOf('---\narguments:\n  - name: Guest Name\n---\n')).toEqual([
      'Guest Name is not an argument name: start with a lowercase letter, then lowercase letters, digits or _ (40 at most), like guest_name',
    ])
    expect(problemsOf('---\narguments:\n  - name: guest\n  - name: guest\n---\n')).toEqual([
      'guest is an argument twice: keep one',
    ])
  })

  it('refuses a title that is not text, saying what it is', () => {
    expect(problemsOf('---\ntitle: [Say, hello]\n---\n')).toEqual(['title is a list: write it as text'])
  })
})

describe('stepsIn', () => {
  it('counts the numbered items at no indent, outside code fences', () => {
    const body = [
      '1. Search.',
      '   1. A step inside a step.',
      '2) Read the best match.',
      '```',
      '3. Not a step: it is in a code block.',
      '```',
      '- A bullet.',
      '3. Answer.',
    ].join('\n')
    expect(stepsIn(body)).toBe(3)
  })
})

describe('toolRefsIn', () => {
  it('returns what is written in single backticks, each once, and nothing from a code block', () => {
    const text = [
      'Run `greet_from_desk`, then `fixture.echo` and `greet_from_desk` again. Not fixture.shout.',
      '```json',
      '{ "tool": "`fixture.shout`" }',
      '```',
      'Set ` to ` to the guest.',
    ].join('\n')
    expect(toolRefsIn(text)).toEqual(['greet_from_desk', 'fixture.echo', 'to'])
  })
})

describe('renderPlaybook', () => {
  it('fills the arguments, then the pack’s variables, and leaves an argument not given empty', () => {
    expect(renderPlaybook(parsed(SAY_HELLO), { guest: 'Sam' }, { desk: 'the desk', guest: 'nobody' })).toBe(
      'Greet Sam from the desk.\n\n1. Run `greet_from_desk` with `to` set to Sam.\n2. Say it back with `fixture.echo`.\n',
    )
    expect(renderPlaybook(parsed('---\narguments:\n  - name: tone\n---\nBe {{tone}}.'), {}, {})).toBe('Be .')
  })

  it('never reads a placeholder out of a value it filled in', () => {
    expect(renderPlaybook(parsed(SAY_HELLO), { guest: '{{desk}}' }, { desk: 'the desk' })).toContain(
      'Greet {{desk}} from the desk.',
    )
  })
})
