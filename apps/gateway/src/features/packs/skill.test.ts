import { skillEntry } from '@modelcontextprotocol/server/ext/skills'
import { describe, expect, it } from 'vitest'
import {
  packSkillPathOf,
  packSkillUriOf,
  SKILL_SECTIONS,
  sectionsOf,
  skillBodyOf,
  skillFile,
  withPlaybookList,
} from './skill.js'

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

  it('fills a variable inside a code block too', () => {
    expect(skillFile(pack(), '```\nfrom: {{desk}}\n```\n~~~\n{{desk}}\n~~~\n', { desk: 'the desk' })).toContain(
      '```\nfrom: the desk\n```\n~~~\nthe desk\n~~~\n',
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

describe('the Playbooks section a build writes', () => {
  const PLAYBOOKS = [
    {
      name: 'find-pricing',
      markdown: '---\ntitle: Find pricing\ndescription: Finds pricing\n  pages.\n---\n\n1. Look.\n',
    },
    { name: 'compare-plans', markdown: '---\ntitle: Compare plans\n---\n\n1. Compare.\n' },
  ]

  it('lists the pack’s playbooks and nothing else, keeping every other section as written', () => {
    const body = BODY.replace('## Playbooks\n\nUse {{desk}}.', '## Playbooks\n\n- task\n- turn: does a turn')
    const listed = withPlaybookList(body, PLAYBOOKS)
    expect(listed).toBe(
      BODY.replace(
        '## Playbooks\n\nUse {{desk}}.',
        '## Playbooks\n\n- `find-pricing`: Finds pricing pages.\n- `compare-plans`: Compare plans',
      ),
    )
    expect(withPlaybookList(body, [])).toContain('## Playbooks\n\nNone yet.\n\n## Gotchas')
  })

  it('leaves a blank text blank, so an empty skill is still refused', () => {
    expect(withPlaybookList('', PLAYBOOKS)).toBe('')
    expect(withPlaybookList('  \n', PLAYBOOKS)).toBe('  \n')
  })

  it('keeps a text’s line endings', () => {
    const crlf = '## Tools\r\nx\r\n## Playbooks\r\nold\r\n## Gotchas\r\ng'
    expect(withPlaybookList(crlf, PLAYBOOKS)).toBe(
      '## Tools\r\nx\r\n## Playbooks\r\n\r\n- `find-pricing`: Finds pricing pages.\r\n- `compare-plans`: Compare plans\r\n\r\n## Gotchas\r\ng',
    )
    expect(withPlaybookList('## Tools\r\nx', [])).toBe('## Tools\r\nx\r\n\r\n## Playbooks\r\n\r\nNone yet.')
  })

  it('names a connection’s playbooks the pack holds after its own, and copies no braces or backticks', () => {
    const odd = {
      name: 'greet-guest',
      markdown: '---\ntitle: Greet\ndescription: Greets {{guest}} with `fixture.greet`.\n---\n\n1. Greet.\n',
    }
    expect(withPlaybookList(BODY, [odd], ['desk-find-pricing'])).toContain(
      '## Playbooks\n\n- `greet-guest`: Greets guest with fixture.greet.\n- `desk-find-pricing`: from a connection\n\n## Gotchas',
    )
  })

  it('adds the section before Gotchas when the text has none, and never reads one in a code block', () => {
    const body = BODY.replace('## Playbooks\n\nUse {{desk}}.\n\n', '').replace(
      'What it is for\n\nUse {{desk}}.',
      'What it is for\n\n```\n## Playbooks\n- task\n```',
    )
    const listed = withPlaybookList(body, PLAYBOOKS.slice(1))
    expect(sectionsOf(listed)).toEqual([...SKILL_SECTIONS])
    expect(listed).toContain('```\n## Playbooks\n- task\n```')
    expect(listed).toContain('## Playbooks\n\n- `compare-plans`: Compare plans\n\n## Gotchas')
  })
})
