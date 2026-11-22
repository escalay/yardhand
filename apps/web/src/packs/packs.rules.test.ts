import { describe, expect, it } from 'vitest'
import { fieldsOf } from '@/tools/schema-form.rules'
import {
  accessOf,
  accountAlias,
  addLabel,
  aliasOf,
  alsoOpens,
  byConnection,
  changesLine,
  changingTools,
  checklistOf,
  connectsVia,
  coversLine,
  dayOf,
  EXTEND_CHOICES,
  effectOf,
  emptyLine,
  endLine,
  endsOf,
  expiryOf,
  failsLine,
  filledIn,
  fixedLine,
  flagLine,
  freeAlias,
  hiddenLine,
  holdsLine,
  INPUT_MODES,
  inputsLine,
  inputValuesOf,
  isAlias,
  isPackName,
  kindOfValue,
  lineOf,
  modeOf,
  nameProblem,
  packQueryOf,
  parsePackTab,
  personalFields,
  personValuesOf,
  placeOf,
  preselected,
  problemLines,
  reasonOf,
  recheckLine,
  recheckOf,
  refusedInputs,
  refusedVariables,
  renameNote,
  SHARE_APPS,
  SHARE_DEFAULT,
  SHARE_LIFETIMES,
  setsAccount,
  shortAddress,
  slugOf,
  stillThere,
  stoodOutLine,
  suggestionsFor,
  toolkitOf,
  uncheckedLine,
  usedLine,
  valuesLine,
  variableProblem,
  variableValueOf,
  withAccountLabels,
  withVariable,
  wordingOf,
  writesVariable,
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

  it('counts the playbooks written for a pack with the ones it holds', () => {
    expect(holdsLine({ tools: 12, playbooks: 2, manuals: 1, ownPlaybooks: 1 })).toBe(
      '12 tools · 3 playbooks · 1 manual',
    )
    expect(holdsLine({ tools: 0, playbooks: 0, manuals: 0, ownPlaybooks: 1 })).toBe('1 playbook')
  })

  it('says what there is to recheck: tools, then the playbooks and the skill written for it', () => {
    const flag = { was: 'written for echo.echo', now: 'echo.echo is not live' }
    const own = (flagged: boolean) => ({ flag: flagged ? flag : null })
    const none = recheckOf({ flags: 0, ownPlaybooks: [own(false)], skill: own(false) })
    expect(none).toEqual({ tools: 0, playbooks: 0, skill: false })
    expect(recheckLine(none)).toBeNull()
    // `flags` counts the pack's own texts too: what is left over is its tools
    const all = recheckOf({ flags: 5, ownPlaybooks: [own(true), own(false), own(true)], skill: own(true) })
    expect(all).toEqual({ tools: 2, playbooks: 2, skill: true })
    expect(recheckLine(all)).toBe('2 tools, 2 playbooks and the skill to recheck')
    expect(recheckLine(recheckOf({ flags: 1, ownPlaybooks: [], skill: null }))).toBe('1 tool to recheck')
    expect(recheckLine(recheckOf({ flags: 1, ownPlaybooks: [own(true)], skill: null }))).toBe('1 playbook to recheck')
    expect(recheckLine(recheckOf({ flags: 1, ownPlaybooks: [], skill: own(true) }))).toBe('The skill to recheck')
    expect(recheckLine(recheckOf({ flags: 2, ownPlaybooks: [], skill: own(true) }))).toBe(
      '1 tool and the skill to recheck',
    )
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
    expect(packQueryOf({ title: 'Support', description: 'Find orders and tickets.' })).toBe(
      'Support. Find orders and tickets.',
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

describe('setting a pack up', () => {
  const pack = (extra: Record<string, unknown> = {}) => ({
    description: '',
    counts: { tools: 0, playbooks: 0, manuals: 0, ownPlaybooks: 0 },
    triedAt: null,
    lastCallAt: null,
    ...extra,
  })
  const doneOf = (list: ReturnType<typeof checklistOf>) => list.steps.filter((step) => step.done).map((step) => step.id)

  it('lists the four steps in order, none done for an empty pack', () => {
    const list = checklistOf(pack({ description: '  ' }))
    expect(list.steps.map((step) => step.id)).toEqual(['describe', 'tools', 'try', 'connect'])
    expect(list.steps.map((step) => step.label)).toEqual([
      'Describe it',
      'Add tools',
      'Try it as the pack',
      'Connect an app',
    ])
    expect(list).toMatchObject({ done: 0, total: 4, complete: false })
  })

  it('ticks a described pack with tools, then the try', () => {
    const built = pack({
      description: 'Say things back.',
      counts: { tools: 2, playbooks: 0, manuals: 0, ownPlaybooks: 0 },
    })
    expect(doneOf(checklistOf(built))).toEqual(['describe', 'tools'])
    const tried = checklistOf({ ...built, triedAt: '2026-11-21T10:00:00Z' })
    expect(doneOf(tried)).toEqual(['describe', 'tools', 'try'])
    expect(tried).toMatchObject({ done: 3, complete: false })
  })

  it('counts a pack whose keys already call as tried and connected', () => {
    const used = checklistOf(
      pack({
        description: 'Say things back.',
        counts: { tools: 2, playbooks: 0, manuals: 0, ownPlaybooks: 0 },
        lastCallAt: '2026-11-21T10:00:00Z',
      }),
    )
    expect(used).toMatchObject({ done: 4, total: 4, complete: true })
  })
})

describe('trying a pack', () => {
  it('says what stood out, and how many of the listed tools did not', () => {
    expect(stoodOutLine(2, 20)).toBe("2 tools stood out · 18 others didn't match")
    expect(stoodOutLine(1, 2)).toBe("1 tool stood out · 1 other didn't match")
  })

  it('only counts what was found when no listed tool is known to have been left out', () => {
    // A small gateway has no bar: a search there answers with the nearest tools, which can be the whole pack
    expect(stoodOutLine(3, 3)).toBe('3 tools found')
    expect(stoodOutLine(1, 1)).toBe('1 tool found')
    expect(stoodOutLine(2, null)).toBe('2 tools found')
    expect(stoodOutLine(2, undefined)).toBe('2 tools found')
  })

  it('says nothing matched, in the pack’s title', () => {
    expect(emptyLine('Loud', 'taxes')).toBe('Nothing in Loud matches “taxes”.')
  })

  it('says what the pack covers, as its keys are told', () => {
    expect(coversLine({ covers: ['Inbox', 'Notes'], more: 0 })).toBe('This pack covers: Inbox, Notes.')
    expect(coversLine({ covers: ['Inbox', 'Notes'], more: 3 })).toBe('This pack covers: Inbox, Notes, and 3 more.')
    expect(coversLine({ covers: [], more: 0 })).toBe('This pack holds no tools this key can use.')
  })

  it('says how many matches a read-only key is not shown', () => {
    expect(hiddenLine(1)).toBe('1 matching tool changes things and is hidden from this read-only key.')
    expect(hiddenLine(2)).toBe('2 matching tools change things and are hidden from this read-only key.')
  })

  it('says why a name cannot be a pack’s', () => {
    expect(nameProblem('draft')).toBeNull()
    expect(nameProblem('')).toBeNull()
    expect(nameProblem('Draft one')).toBe('Lowercase letters, digits and dashes, starting with a letter or digit.')
    expect(nameProblem('-draft')).toBe('Lowercase letters, digits and dashes, starting with a letter or digit.')
    // Reserved by the API, though it fits the pattern
    expect(nameProblem('flags')).toBe('flags is taken: pick another name.')
  })

  it('says who a rename leaves working at the old address', () => {
    expect(renameNote(1, 'draft')).toBe('Its 1 person keeps working at /p/draft; new setup says the new address.')
    expect(renameNote(2, 'draft')).toBe('Its 2 people keep working at /p/draft; new setup says the new address.')
    expect(renameNote(0, 'draft')).toBe('Nobody has a working key to it, so nobody connects at /p/draft now.')
  })

  it('shows an address without its scheme', () => {
    expect(shortAddress('https://gw.example.com/p/loud')).toBe('gw.example.com/p/loud')
    expect(shortAddress('http://localhost:4400/p/loud')).toBe('localhost:4400/p/loud')
  })
})

describe('a pack’s page in the address', () => {
  it('reads every part but Tools, the default', () => {
    expect(parsePackTab({ tab: 'overview' })).toEqual({ tab: 'overview' })
    expect(parsePackTab({ tab: 'people' })).toEqual({ tab: 'people' })
    expect(parsePackTab({ tab: 'tools' })).toEqual({})
    expect(parsePackTab({ tab: 'nowhere' })).toEqual({})
    expect(parsePackTab({ add: true })).toEqual({ add: true })
  })

  it('opens People for a link kept from when it was Keys', () => {
    expect(parsePackTab({ tab: 'keys' })).toEqual({ tab: 'people' })
  })

  it('opens the Share sheet over the part it was asked on', () => {
    expect(parsePackTab({ share: true })).toEqual({ share: true })
    expect(parsePackTab({ tab: 'overview', share: true })).toEqual({ tab: 'overview', share: true })
    expect(parsePackTab({ tab: 'keys', share: true })).toEqual({ tab: 'people', share: true })
    expect(parsePackTab({ share: 'yes' })).toEqual({})
  })
})

describe('sharing a pack', () => {
  const tool = (needsWrite: boolean, live = true) => ({ needsWrite, live })

  it('offers 7 days, 30 days and until revoked, 30 days unless said', () => {
    expect(SHARE_LIFETIMES.map((choice) => [choice.value, choice.label])).toEqual([
      ['7d', '7 days'],
      ['30d', '30 days'],
      ['never', 'Until revoked'],
    ])
    expect(SHARE_DEFAULT).toBe('30d')
  })

  it('asks which app, Claude Code first, and takes not being sure', () => {
    expect(SHARE_APPS.map((choice) => [choice.app, choice.label])).toEqual([
      ['claude-code', 'Claude Code'],
      ['cursor', 'Cursor'],
      ['codex', 'Codex'],
      ['curl', 'A script'],
      [null, 'Not sure'],
    ])
    // A radio's value is text: no two choices share one
    expect(new Set(SHARE_APPS.map((choice) => choice.value)).size).toBe(SHARE_APPS.length)
  })

  it('counts the live tools that change things: only then is what they can do asked', () => {
    expect(changingTools({ tools: [tool(false), tool(true), tool(true)] })).toBe(2)
    expect(changingTools({ tools: [tool(false), tool(true, false)] })).toBe(0)
    expect(changingTools({ tools: [] })).toBe(0)
    expect(changesLine(1)).toBe('1 tool here changes things')
    expect(changesLine(3)).toBe('3 tools here change things')
  })
})

describe('a pack’s people', () => {
  const NOW = Date.parse('2026-12-01T10:00:00Z')
  const person = (expiresAt: string | null, extra: { ending?: boolean; ended?: boolean } = {}) => ({
    expiresAt,
    ...extra,
  })

  it('says how a person connects', () => {
    expect(connectsVia({ app: 'claude-code', kind: 'key' })).toBe('Claude Code · key')
    expect(connectsVia({ app: 'curl', kind: 'key' })).toBe('A script · key')
    expect(connectsVia({ app: 'typescript', kind: 'key' })).toBe('TypeScript · key')
    expect(connectsVia({ app: null, kind: 'key' })).toBe('key')
    expect(connectsVia({ app: 'claude-ai', kind: 'oauth' })).toBe('claude.ai · sign-in')
    expect(connectsVia({ app: null, kind: 'oauth' })).toBe('sign-in')
  })

  it('says what a person can do', () => {
    expect(accessOf('read')).toBe('read only')
    expect(accessOf('write')).toBe('can change')
  })

  it('says when access ends: never, the day, or how soon', () => {
    expect(endsOf(person(null), NOW)).toEqual({ text: 'never', warn: false })
    expect(endsOf(person('2026-12-21T10:00:00Z'), NOW)).toEqual({ text: '21 Dec', warn: false })
    expect(endsOf(person('2026-12-04T10:00:00Z', { ending: true }), NOW)).toEqual({ text: 'in 3 d', warn: true })
    expect(endsOf(person('2026-12-02T16:00:00Z', { ending: true }), NOW)).toEqual({ text: 'in 1 d', warn: true })
    expect(endsOf(person('2026-12-01T15:00:00Z', { ending: true }), NOW)).toEqual({ text: 'in 5 h', warn: true })
    expect(endsOf(person('2026-12-01T10:20:00Z', { ending: true }), NOW)).toEqual({ text: 'in 20 min', warn: true })
  })

  it('counts the days as Home’s nudge does: UTC days, not hours rounded', () => {
    // Home: "ends in 2 days (3 Dec 2026)"
    expect(endsOf(person('2026-12-03T23:00:00Z', { ending: true }), NOW).text).toBe('in 2 d')
    // 26 hours left across two midnights: Home says "in 2 days"
    const late = Date.parse('2026-12-01T23:00:00Z')
    expect(endsOf(person('2026-12-03T01:00:00Z', { ending: true }), late).text).toBe('in 2 d')
    expect(endsOf(person('2026-12-04T22:59:00Z', { ending: true }), late).text).toBe('in 3 d')
  })

  it('says a key made for a day or less ends soon, without the warning: it was meant to', () => {
    expect(endsOf(person('2026-12-01T18:00:00Z'), NOW)).toEqual({ text: 'in 8 h', warn: false })
    expect(endsOf(person('2026-12-02T10:00:00Z'), NOW)).toEqual({ text: 'in 1 d', warn: false })
  })

  it('says the day access ended, in UTC as the message they were sent says it', () => {
    expect(endsOf(person('2026-11-02T23:30:00Z', { ended: true }), NOW)).toEqual({ text: 'ended 2 Nov', warn: false })
    // Ended since the list was read
    expect(endsOf(person('2026-12-01T09:59:00Z'), NOW)).toEqual({ text: 'ended 1 Dec', warn: false })
  })

  it('says the same in a line beside a name', () => {
    expect(endLine(person(null), NOW)).toBe('until revoked')
    expect(endLine(person('2026-12-21T10:00:00Z'), NOW)).toBe('ends 21 Dec')
    expect(endLine(person('2026-12-01T18:00:00Z'), NOW)).toBe('ends in 8 h')
    // Ended while the page was open
    expect(endLine(person('2026-12-01T09:59:00Z'), NOW)).toBe('ended 1 Dec')
  })

  it('offers the three ends Extend can set, counted from today', () => {
    expect(EXTEND_CHOICES.map((choice) => [choice.value, choice.label])).toEqual([
      ['7d', '7 days from today'],
      ['30d', '30 days from today'],
      ['never', 'Until revoked'],
    ])
    expect(EXTEND_CHOICES.map((choice) => choice.value)).toEqual(SHARE_LIFETIMES.map((choice) => choice.value))
  })

  it('warns that a key opens other packs, which an Extend or a revoke changes too', () => {
    expect(alsoOpens([])).toBe('')
    expect(alsoOpens(['desk'])).toBe('This key also opens desk: that changes too.')
    expect(alsoOpens(['desk', 'quiet'])).toBe('This key also opens desk and quiet: that changes too.')
    expect(alsoOpens(['desk', 'quiet', 'kit'])).toBe('This key also opens desk, quiet and kit: that changes too.')
  })

  it('says who still connects at an old address', () => {
    expect(stillThere(0)).toBe('nobody has connected there since the rename')
    expect(stillThere(1)).toBe('1 person still connects there')
    expect(stillThere(2)).toBe('2 people still connect there')
    expect(dayOf('2026-12-02T23:30:00Z')).toBe('2 Dec')
  })
})

describe('what a pack sets on a tool’s inputs', () => {
  const tool = { fixed: { account: '{{account}}' }, defaults: { posted_since: 7 } }
  const fields = fieldsOf({
    type: 'object',
    properties: {
      id: { type: 'string' },
      verbose: { type: 'boolean' },
      limit: { type: 'integer', default: 10 },
      tone: { enum: ['calm', 'loud'] },
      tags: { type: 'array' },
    },
    required: ['id', 'limit'],
  })

  it('says who fills an input, from what the pack stores', () => {
    expect(modeOf(tool, 'account')).toBe('fixed')
    expect(modeOf(tool, 'posted_since')).toBe('default')
    expect(modeOf(tool, 'query')).toBe('agent')
    // An input named like something every object has is the agent's until the pack sets it
    expect(modeOf(tool, 'constructor')).toBe('agent')
    expect(modeOf({ fixed: {}, defaults: { toString: 'x' } }, 'toString')).toBe('default')
  })

  it('says what a pack tool sets, by mode', () => {
    expect(inputsLine(tool)).toBe('Fixed account = {{account}} · Default posted_since = 7')
    expect(inputsLine({ fixed: { from: 'the desk', account: 'work' }, defaults: {} })).toBe(
      'Fixed from = the desk · account = work',
    )
    expect(inputsLine({ fixed: {}, defaults: { limit: '{{page_size}}' } })).toBe('Default limit = {{page_size}}')
    expect(inputsLine({ fixed: {}, defaults: {} })).toBe('')
  })

  it('shows an account by its label, fixed or as a default, and keeps one the connection doesn’t list', () => {
    const labelOf = (account: string) => ({ ca_1: 'Work inbox', ca_2: 'Home inbox' })[account]
    expect(inputsLine(withAccountLabels({ fixed: { account: 'ca_1' }, defaults: { limit: 5 } }, labelOf))).toBe(
      'Fixed account = Work inbox · Default limit = 5',
    )
    expect(inputsLine(withAccountLabels({ fixed: {}, defaults: { account: 'ca_2', limit: 5 } }, labelOf))).toBe(
      'Default account = Home inbox · limit = 5',
    )
    expect(inputsLine(withAccountLabels({ fixed: {}, defaults: { account: '{{account}}' } }, labelOf))).toBe(
      'Default account = {{account}}',
    )
  })

  it('knows a tool whose account the pack sets, in either mode', () => {
    expect(setsAccount({ fixed: { account: 'ca_1' }, defaults: {} })).toBe(true)
    expect(setsAccount({ fixed: {}, defaults: { account: 'ca_2' } })).toBe(true)
    expect(setsAccount({ fixed: { from: 'the desk' }, defaults: { limit: 5 } })).toBe(false)
  })

  it('knows a value that writes a variable, as the gateway reads it', () => {
    expect(writesVariable('{{page_size}}')).toBe(true)
    expect(writesVariable('from {{ desk }}')).toBe(true)
    expect(writesVariable('{{ 1+1 }}')).toBe(false)
    expect(writesVariable('{{Desk}}')).toBe(false)
    expect(writesVariable('7')).toBe(false)
  })

  it('fills a value in for the owner to read, and names a word that is no variable', () => {
    const variables = [
      { name: 'page_size', value: 5 },
      { name: 'desk', value: 'the desk' },
    ]
    expect(filledIn('{{page_size}}', variables)).toEqual({ text: '5', undeclared: [] })
    expect(filledIn('from {{desk}}, {{first_name}}', variables)).toEqual({
      text: 'from the desk, {{first_name}}',
      undeclared: ['first_name'],
    })
    expect(filledIn('plain', variables)).toEqual({ text: 'plain', undeclared: [] })
  })

  it('turns the form into what the pack fixes and defaults', () => {
    const { fixed, defaults, errors } = inputValuesOf(
      fields,
      { id: 'fixed', verbose: 'default', limit: 'default', tone: 'agent', tags: 'fixed' },
      { id: '42', verbose: 'true', limit: '7', tone: 'calm', tags: '["a"]' },
    )
    expect(fixed).toEqual({ id: '42', tags: ['a'] })
    expect(defaults).toEqual({ verbose: true, limit: 7 })
    expect(errors).toEqual({})
  })

  it('sends a value that writes a variable as written, whatever the input takes', () => {
    const { fixed, defaults, errors } = inputValuesOf(
      fields,
      { limit: 'default', verbose: 'fixed', tone: 'fixed' },
      { limit: ' {{page_size}} ', verbose: '{{chatty}}', tone: '{{tone}}' },
    )
    expect(defaults).toEqual({ limit: '{{page_size}}' })
    expect(fixed).toEqual({ verbose: '{{chatty}}', tone: '{{tone}}' })
    expect(errors).toEqual({})
  })

  it('keeps a switch that is off as false, and asks for a value where there is none', () => {
    const { fixed, defaults, errors } = inputValuesOf(
      fields,
      { verbose: 'fixed', id: 'default', limit: 'fixed' },
      { verbose: '', id: ' ', limit: 'seven' },
    )
    expect(fixed).toEqual({ verbose: false })
    expect(defaults).toEqual({})
    expect(errors).toEqual({ id: 'Give it a value, or let the agent decide.', limit: 'A whole number.' })
  })

  it('leaves out an input the agent decides, and one the form does not mention', () => {
    expect(inputValuesOf(fields, { id: 'agent' }, { id: '42', limit: '7' })).toEqual({
      fixed: {},
      defaults: {},
      person: {},
      errors: {},
    })
  })

  it('writes a picked variable into a value: over a typed one, at the end of text', () => {
    const [id, verbose, limit] = fields
    if (!id || !verbose || !limit) throw new Error('the schema above has these three inputs first')
    expect(withVariable(limit, '10', 'page_size')).toBe('{{page_size}}')
    expect(withVariable(verbose, 'true', 'chatty')).toBe('{{chatty}}')
    expect(withVariable(id, '', 'item')).toBe('{{item}}')
    expect(withVariable(id, 'item-', 'item')).toBe('item-{{item}}')
  })

  it('lists what no longer fits a tool: inputs it dropped, then values it refuses', () => {
    expect(
      problemLines({
        tool: 'fixture.greet',
        lostInputs: ['from', 'colour'],
        inputs: [
          { name: 'to', mode: 'agent', required: true, problem: null, note: null, unchecked: false },
          {
            name: 'tone',
            mode: 'default',
            required: false,
            problem: 'tone must be equal to one of the allowed values',
            note: null,
            unchecked: false,
          },
        ],
      }),
    ).toEqual(['fixture.greet no longer takes from, colour', 'tone must be equal to one of the allowed values'])
    expect(problemLines({ tool: 'fixture.greet', lostInputs: [], inputs: [] })).toEqual([])
  })

  it('says what a flagged value does to calls: the worst of what stands', () => {
    const input = (mode: 'fixed' | 'default' | 'agent', problem: string | null) => ({
      name: 'tone',
      mode,
      required: false,
      problem,
      note: null,
      unchecked: false,
    })
    const refused = 'tone must be equal to one of the allowed values'
    expect(failsLine({ lostInputs: [], inputs: [input('default', refused), input('fixed', refused)] })).toBe(
      'every call fails until you change what the pack sets',
    )
    expect(failsLine({ lostInputs: ['from'], inputs: [input('default', refused), input('fixed', null)] })).toBe(
      'calls that don’t send their own value fail until you change what the pack sets',
    )
    expect(failsLine({ lostInputs: ['from'], inputs: [input('agent', null)] })).toBe(
      'the pack still sends it, so calls fail only if the server refuses an input it doesn’t know. Change what the pack sets',
    )
    expect(failsLine({ lostInputs: ['from', 'colour'], inputs: [] })).toBe(
      'the pack still sends them, so calls fail only if the server refuses an input it doesn’t know. Change what the pack sets',
    )
  })

  it('names the values the gateway could not check, so no fit is claimed for them', () => {
    const input = (name: string, unchecked: boolean) => ({
      name,
      mode: 'fixed' as const,
      required: false,
      problem: null,
      note: null,
      unchecked,
    })
    expect(uncheckedLine({ inputs: [input('to', false), input('tone', true)] })).toBe(
      'tone was not checked: the gateway can’t read its schema, so only a call checks it.',
    )
    expect(uncheckedLine({ inputs: [input('to', true), input('tone', true)] })).toBe(
      'to, tone were not checked: the gateway can’t read their schema, so only a call checks them.',
    )
    expect(uncheckedLine({ inputs: [input('to', false)] })).toBeNull()
  })
})

describe('an input each person fills', () => {
  const tool = {
    fixed: { account: 'ca_1' },
    defaults: {},
    person: { location: '{{city}}' },
  }
  const fields = fieldsOf({
    type: 'object',
    properties: { location: { type: 'string' }, limit: { type: 'integer' }, verbose: { type: 'boolean' } },
  })

  it('is its own mode, with a hint that says the person’s value is theirs', () => {
    expect(modeOf(tool, 'location')).toBe('person')
    expect(modeOf(tool, 'account')).toBe('fixed')
    expect(INPUT_MODES.map((mode) => mode.label)).toEqual(['Fixed', 'Default', 'Agent decides', 'Per person'])
    expect(INPUT_MODES.find((mode) => mode.id === 'person')?.hint).toBe(
      'Hidden from the agent and filled with each person’s own value, set under People; else the pack’s. Use Fixed for anything that limits what they reach.',
    )
  })

  it('says what a pack tool fills per person, with its account by its label', () => {
    expect(inputsLine(tool)).toBe('Fixed account = ca_1 · Per person location = {{city}}')
    expect(inputsLine(withAccountLabels(tool, () => 'Work inbox'))).toBe(
      'Fixed account = Work inbox · Per person location = {{city}}',
    )
  })

  it('turns the form into the variable each input reads, and asks for one where there is none', () => {
    expect(
      inputValuesOf(
        fields,
        { location: 'person', limit: 'person', verbose: 'person' },
        { location: ' {{city}} ', limit: '7', verbose: '' },
      ),
    ).toEqual({
      fixed: {},
      defaults: {},
      person: { location: '{{city}}' },
      errors: { limit: 'Pick the variable each person fills.', verbose: 'Pick the variable each person fills.' },
    })
  })

  it('reads where a refusal of one sits', () => {
    expect(placeOf('tools.items.get_item.person.location')).toEqual({ tool: 'items.get_item', input: 'location' })
    expect(placeOf('values.city')).toEqual({ variable: 'city' })
  })

  it('fills a value in with the pack’s value, and none for a variable without one', () => {
    expect(filledIn('{{city}}', [{ name: 'city', value: null }])).toEqual({ text: '{{city}}', undeclared: [] })
  })

  it('gives the Share sheet and People a field per variable each person fills, with the pack’s value to fall back on', () => {
    const pack = {
      variables: [
        { name: 'city', value: 'Lisbon', description: 'Where they are.', perPerson: true, usedBy: [] },
        { name: 'days', value: 7, description: null, perPerson: true, usedBy: [] },
        { name: 'account', value: 'ca_1', description: null, perPerson: false, usedBy: [] },
        { name: 'team', value: null, description: null, perPerson: true, usedBy: [] },
      ],
    }
    expect(personalFields(pack)).toEqual([
      {
        name: 'city',
        kind: 'text',
        hint: 'Where they are. Left empty, they get the pack’s: Lisbon.',
        fallback: 'Lisbon',
      },
      { name: 'days', kind: 'number', hint: 'Left empty, they get the pack’s: 7.', fallback: 7 },
      {
        name: 'team',
        kind: 'text',
        hint: 'Left empty, they get nothing, and a call that needs it is refused.',
        fallback: null,
      },
    ])
  })

  it('reads the typed values by each variable’s kind, leaving out what is empty', () => {
    const fields = personalFields({
      variables: [
        { name: 'city', value: 'Lisbon', description: null, perPerson: true },
        { name: 'days', value: 7, description: null, perPerson: true },
      ],
    })
    expect(personValuesOf(fields, { city: ' Porto ', days: '3' })).toEqual({
      values: { city: 'Porto', days: 3 },
      errors: {},
    })
    expect(personValuesOf(fields, { city: '', days: 'three' })).toEqual({
      values: {},
      errors: { days: 'A number, like 7.' },
    })
  })

  it('reads yes or no as true or false, and nothing else', () => {
    const [flag] = personalFields({
      variables: [{ name: 'loud', value: false, description: null, perPerson: true }],
    })
    if (!flag) throw new Error('one field')
    expect(personValuesOf([flag], { loud: 'True' })).toEqual({ values: { loud: true }, errors: {} })
    expect(personValuesOf([flag], { loud: 'false' })).toEqual({ values: { loud: false }, errors: {} })
    expect(personValuesOf([flag], { loud: 'yes' })).toEqual({ values: {}, errors: { loud: 'true or false.' } })
  })

  it('says a person’s values in one line', () => {
    expect(valuesLine({ city: 'Porto', days: 3 })).toBe('city: Porto · days: 3')
    expect(valuesLine({})).toBe('')
  })
})

describe('a pack’s variables', () => {
  it('checks a new variable’s name', () => {
    const taken = new Set(['page_size'])
    expect(variableProblem('desk_name', taken)).toBeNull()
    expect(variableProblem('', taken)).toBe('Give it a name, like desk_name.')
    expect(variableProblem('Desk name', taken)).toBe(
      'Start with a lowercase letter, then lowercase letters, digits or _ (40 at most), like desk_name.',
    )
    expect(variableProblem('a'.repeat(41), taken)).toMatch(/^Start with a lowercase letter/)
    expect(variableProblem('page_size', taken)).toBe(
      'page_size is already a variable of this pack: change that one, or pick another name.',
    )
  })

  it('reads a value as the kind the owner picked', () => {
    expect(variableValueOf('number', ' 7 ')).toEqual({ value: 7, error: null })
    expect(variableValueOf('number', 'seven')).toEqual({ value: null, error: 'A number, like 7.' })
    expect(variableValueOf('number', '')).toEqual({ value: null, error: 'A number, like 7.' })
    expect(variableValueOf('text', '7')).toEqual({ value: '7', error: null })
    expect(variableValueOf('text', '')).toEqual({ value: null, error: 'Give it a value.' })
    expect(variableValueOf('boolean', 'true')).toEqual({ value: true, error: null })
    expect(variableValueOf('boolean', '')).toEqual({ value: false, error: null })
  })

  it('starts an edit from the kind of the stored value', () => {
    expect(kindOfValue(5)).toBe('number')
    expect(kindOfValue('5')).toBe('text')
    expect(kindOfValue(false)).toBe('boolean')
    expect(kindOfValue(null)).toBe('text')
  })

  it('says which tools write a variable', () => {
    expect(usedLine(['items.get_item', 'work_inbox'])).toBe('Used by items.get_item, work_inbox')
    expect(usedLine([])).toBe('Not used yet')
  })
})

describe('a refused save', () => {
  it('reads where a problem sits, with dots in the tool’s name', () => {
    expect(placeOf('tools.items.get_item.defaults.limit')).toEqual({ tool: 'items.get_item', input: 'limit' })
    expect(placeOf('tools.work_inbox.fixed.account')).toEqual({ tool: 'work_inbox', input: 'account' })
    expect(placeOf('variables.page_size')).toEqual({ variable: 'page_size' })
    expect(placeOf('tools.items.get_item')).toBeNull()
    expect(placeOf('alias')).toBeNull()
  })

  it('puts each problem beside its input, and keeps the rest to say under the form', () => {
    const refused = {
      message: 'Not saved: limit must be integer; colour is gone. GET /api/tools/{name} shows each tool’s inputs.',
      errors: [
        { path: 'tools.items.get_item.defaults.limit', message: 'limit must be integer' },
        { path: 'tools.items.get_item.fixed.colour', message: 'items.get_item has no input colour' },
        { path: 'tools.other.fixed.limit', message: 'limit must be integer' },
      ],
    }
    expect(refusedInputs(refused, ['items.get_item'], ['id', 'limit'])).toEqual({
      byInput: { limit: 'limit must be integer.' },
      rest: ['items.get_item has no input colour.', 'other: limit must be integer.'],
    })
  })

  it('says the whole answer when it names no place', () => {
    expect(
      refusedInputs({ message: 'Loud already has a tool called echo: pick another alias.', errors: [] }, ['echo'], []),
    ).toEqual({ byInput: {}, rest: ['Loud already has a tool called echo: pick another alias.'] })
  })

  it('puts a refused variable beside its row, and a value that stops fitting beside the variable it writes', () => {
    const tools = [
      { name: 'items.get_item', fixed: {}, defaults: { limit: '{{page_size}}' } },
      { name: 'work_inbox', fixed: { account: '{{account}}' }, defaults: {} },
    ]
    expect(
      refusedVariables(
        {
          message: 'Not saved: …',
          errors: [
            {
              path: 'variables.account',
              message: '{{account}} is still used by work_inbox (account): change that first, or keep the variable.',
            },
            { path: 'tools.items.get_item.defaults.limit', message: 'limit must be integer' },
            { path: 'tools.gone.fixed.x', message: 'x must be string' },
          ],
        },
        tools,
      ),
    ).toEqual({
      byVariable: {
        account: ['{{account}} is still used by work_inbox (account): change that first, or keep the variable.'],
        page_size: ['items.get_item: limit must be integer.'],
      },
      rest: ['gone: x must be string.'],
    })
    expect(refusedVariables({ message: 'The gateway did not answer.', errors: [] }, tools)).toEqual({
      byVariable: {},
      rest: ['The gateway did not answer.'],
    })
  })
})

describe('flagLine', () => {
  it('says what a tool’s server says now, and what is wrong with a value', () => {
    expect(flagLine({ kind: 'wording', was: 'Echoes.', now: 'Says it back.' })).toBe(
      'Its server now says: Says it back.',
    )
    expect(flagLine({ kind: 'input', was: 'fixes from', now: 'fixture.greet no longer takes from' })).toBe(
      'fixture.greet no longer takes from. Open the pack to change the value.',
    )
  })

  it('says which tools a playbook or the skill was written for, and what to do', () => {
    const flag = { was: 'written for greet_from_desk, fixture.echo', now: 'greet_from_desk is no longer in Front desk' }
    expect(flagLine({ kind: 'playbook', ...flag })).toBe(
      'It was written for greet_from_desk, fixture.echo, which changed or left the pack since. Read it again and save it.',
    )
    expect(flagLine({ kind: 'skill', ...flag })).toBe(flagLine({ kind: 'playbook', ...flag }))
  })
})
