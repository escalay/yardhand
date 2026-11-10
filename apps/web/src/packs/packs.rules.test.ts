import { describe, expect, it } from 'vitest'
import {
  accountAlias,
  addLabel,
  aliasOf,
  byConnection,
  effectOf,
  expiryOf,
  fixedLine,
  freeAlias,
  holdsLine,
  isAlias,
  isPackName,
  lineOf,
  packQueryOf,
  preselected,
  reasonOf,
  slugOf,
  suggestionsFor,
  toolkitOf,
  wordingOf,
} from './packs.rules'

describe('packs', () => {
  it('names a pack from its title', () => {
    expect(slugOf('Design reviews')).toBe('design-reviews')
    expect(slugOf('  Acme · queries!  ')).toBe('acme-queries')
    expect(slugOf('Café')).toBe('cafe')
    expect(isPackName(slugOf('Design reviews'))).toBe(true)
    expect(isPackName('flags')).toBe(false)
    expect(isPackName('')).toBe(false)
  })

  it('says what a pack holds, leaving out what it has none of', () => {
    expect(holdsLine({ tools: 12, playbooks: 1, manuals: 0 })).toBe('12 tools · 1 playbook')
    expect(holdsLine({ tools: 0, playbooks: 0, manuals: 0 })).toBe('Nothing in it yet')
  })

  it('says why a tool is in', () => {
    const titleOf = (name: string) => (name === 'cookbook-plan-a-dinner' ? 'Cookbook · Plan a dinner' : name)
    expect(reasonOf({ reason: 'named', via: 'cookbook-plan-a-dinner' }, titleOf)).toBe(
      'Named in Cookbook · Plan a dinner',
    )
    expect(reasonOf({ reason: 'route', via: 'cookbook-plan-a-dinner' }, titleOf)).toBe(
      'Called by Cookbook · Plan a dinner',
    )
    expect(reasonOf({ reason: 'picked', via: null }, titleOf)).toBe('Picked')
  })

  it('shows the pack’s wording when it has one', () => {
    expect(wordingOf({ wording: 'Ours', upstreamDescription: 'Theirs' })).toEqual({ text: 'Ours', own: true })
    expect(wordingOf({ wording: null, upstreamDescription: 'Theirs' })).toEqual({ text: 'Theirs', own: false })
  })

  it('checks the certain uses not already in', () => {
    expect(
      preselected([
        { tool: 'a', reason: 'named', inPack: false, title: null, summary: '' },
        { tool: 'b', reason: 'route', inPack: true, title: null, summary: '' },
        { tool: 'c', reason: 'meaning', inPack: false, title: null, summary: '' },
      ]),
    ).toEqual(['a'])
  })

  it('says how long a key has left', () => {
    const now = Date.parse('2026-11-08T10:00:00Z')
    expect(expiryOf(null, now)).toEqual({ text: 'Never expires', expired: false })
    expect(expiryOf('2026-11-08T18:00:00Z', now).text).toBe('Expires in 8 h')
    expect(expiryOf('2026-11-08T10:30:00Z', now).text).toBe('Expires in 30 min')
    expect(expiryOf('2026-11-15T10:00:00Z', now).text).toBe('Expires in 7 days')
    expect(expiryOf('2026-11-08T09:00:00Z', now)).toEqual({ text: 'Expired', expired: true })
  })
})

describe('adding tools by hand', () => {
  const tool = (name: string, extra: Record<string, unknown> = {}) =>
    ({
      name,
      upstream: name.split('.')[0] ?? '',
      title: null,
      summary: '',
      needsWrite: false,
      access: null,
      pinned: false,
      calls7d: null,
      _links: {},
      ...extra,
    }) as never

  it('groups tools by connection, keeping their order', () => {
    expect(
      byConnection([tool('cookbook.a'), tool('notes.b'), tool('cookbook.c')]).map((group) => [
        group.upstream,
        group.tools.length,
      ]),
    ).toEqual([
      ['cookbook', 2],
      ['notes', 1],
    ])
  })

  it('suggests what the pack lacks, never what is switched off', () => {
    const ranked = [tool('cookbook.a'), tool('cookbook.b', { access: 'off' }), tool('notes.c'), tool('notes.d')]
    expect(suggestionsFor(ranked, new Set(['cookbook.a']), 2).map((found: { name: string }) => found.name)).toEqual([
      'notes.c',
      'notes.d',
    ])
  })

  it('searches by what the pack is for', () => {
    expect(packQueryOf({ title: 'Design', description: 'Find screens and notes.' })).toBe(
      'Design. Find screens and notes.',
    )
  })

  it('says what the button does', () => {
    expect(addLabel(0)).toBe('Choose tools to add')
    expect(addLabel(1)).toBe('Add 1 tool')
    expect(addLabel(3)).toBe('Add 3 tools')
  })
})

describe('a tool in one line', () => {
  it('says its title only when the summary doesn’t already', () => {
    expect(lineOf({ name: 'items.delete_item', title: 'Delete an item', summary: 'Delete an item' })).toBe(
      'Delete an item',
    )
    expect(lineOf({ name: 'x.y', title: 'Board', summary: 'Lists boards.' })).toBe('Board: Lists boards.')
    expect(lineOf({ name: 'x.y', title: null, summary: 'Lists boards.' })).toBe('Lists boards.')
  })

  it('names a pack tool from its title or slug', () => {
    expect(aliasOf('Fetch emails')).toBe('fetch_emails')
    expect(aliasOf('GMAIL_FETCH_EMAILS')).toBe('gmail_fetch_emails')
    expect(aliasOf('2 Create a draft!')).toBe('create_a_draft')
    expect(isAlias(aliasOf('Fetch emails'))).toBe(true)
    expect(isAlias('cookbook.search')).toBe(false)
    expect(isAlias('x')).toBe(false)
  })

  it('says what a pack tool fixes', () => {
    expect(fixedLine({ from: 'the desk', limit: 5 })).toBe('from = the desk · limit = 5')
    expect(fixedLine({})).toBe('')
  })

  it('reads a Composio tool’s app and effect, and names it after the account it runs on', () => {
    expect(toolkitOf('composio.googlecalendar_events_list', ['gmail', 'googlecalendar'])).toBe('googlecalendar')
    expect(toolkitOf('composio.google_maps_search', ['google_maps'])).toBe('google_maps')
    expect(toolkitOf('composio.gmail_fetch_emails', [])).toBe('gmail')
    expect(effectOf({ needsWrite: false, destructive: false })).toBe('reads')
    expect(effectOf({ needsWrite: true, destructive: false })).toBe('changes')
    expect(effectOf({ needsWrite: true, destructive: true })).toBe('deletes')
    expect(accountAlias('Acme Work Email - sam@acme.test', 'Fetch emails')).toBe('acme_fetch_emails')
    expect(accountAlias('Primary Personal Account', 'List Events')).toBe('primary_list_events')
    expect(freeAlias('work_inbox', new Set(['work_inbox', 'work_inbox_2']))).toBe('work_inbox_3')
    expect(freeAlias('work_inbox', new Set())).toBe('work_inbox')
  })
})
