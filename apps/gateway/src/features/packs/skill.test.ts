import { skillEntry } from '@modelcontextprotocol/server/ext/skills'
import { describe, expect, it } from 'vitest'
import { packSkillPathOf, packSkillUriOf, SKILL_SECTIONS, sectionsOf, skillBodyOf, skillFile } from './skill.js'

const BODY = SKILL_SECTIONS.map((section) => `## ${section}\n\nUse {{desk}}.`).join('\n\n')
const pack = (over: Partial<{ name: string; title: string; description: string }> = {}) => ({
  name: 'desk',
  title: 'Front desk',
  description: 'Greets people at the door.\n\nMore about it.',
  ...over,
})
/** The skill as the SDK's own rules read it: the name and description it would list. */
const listed = async (of: ReturnType<typeof pack>) => {
  const entry = await skillEntry(packSkillPathOf(of.name), { 'SKILL.md': skillFile(of, BODY, {}) })
  return { name: entry.frontmatter.name, description: entry.frontmatter.description }
}

describe('skillFile', () => {
  it('writes the front matter itself, then the heading and the text with the variables filled in', () => {
    expect(skillFile(pack(), 'Greet from {{desk}}, as {{guest}}.\n', { desk: 'the desk' })).toBe(
      [
        '---',
        'name: desk',
        'description: "Working with Front desk: Greets people at the door."',
        '---',
        '',
        '# Working with Front desk',
        '',
        'Greet from the desk, as {{guest}}.',
        '',
      ].join('\n'),
    )
  })

  it('passes the SDK’s rules for a pack with nothing said about it', async () => {
    expect(await listed(pack({ description: '' }))).toEqual({ name: 'desk', description: 'Working with Front desk.' })
  })

  it('passes them for a description with a colon, a quote and a line break', async () => {
    expect(await listed(pack({ description: 'Greets: "hello",\nat the door.\n\nMore.' }))).toEqual({
      name: 'desk',
      description: 'Working with Front desk: Greets: "hello", at the door.',
    })
  })

  it('passes them for a description over 1024 characters, cut', async () => {
    const { description } = await listed(pack({ description: 'door '.repeat(400) }))
    expect(description.length).toBe(1024)
    expect(description.startsWith('Working with Front desk: door door')).toBe(true)
  })

  it('passes them for a pack named with two dashes or a dash at its end', async () => {
    expect(packSkillPathOf('a--b')).toBe('a-b')
    expect(packSkillPathOf('a-b-')).toBe('a-b')
    expect(packSkillUriOf('a--b')).toBe('skill://a-b/SKILL.md')
    expect((await listed(pack({ name: 'a--b' }))).name).toBe('a-b')
  })
})

describe('skillBodyOf', () => {
  it('keeps only the text: front matter and a first heading are the gateway’s to write', () => {
    const written = skillFile(pack(), BODY, {})
    expect(skillBodyOf(written)).toBe(BODY)
    expect(skillBodyOf(BODY)).toBe(BODY)
    expect(skillBodyOf('\n# My own heading\n\nGreet them.\n\n# A later heading\n')).toBe(
      'Greet them.\n\n# A later heading\n',
    )
  })
})

describe('sectionsOf', () => {
  it('finds the six headings, however the apostrophe and the capitals are typed', () => {
    expect(sectionsOf(BODY)).toEqual([...SKILL_SECTIONS])
    expect(sectionsOf('## what it is for\n\n## What it can’t do\n\n### Gotchas\n\n```\n## Playbooks\n```')).toEqual([
      'What it is for',
      "What it can't do",
    ])
  })
})
