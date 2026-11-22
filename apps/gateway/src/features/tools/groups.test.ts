import { describe, expect, it } from 'vitest'
import { actsAs, COVERS_MAX, coversOf, effectOf, groupByRules, OTHER, ruleGroupOf } from './groups.js'

describe('groups by rules', () => {
  it('files a Composio tool by its app, a kit tool by its route, any other by the noun in its name', () => {
    expect(ruleGroupOf({ remoteName: 'googlecalendar_events_list' }, ['gmail', 'googlecalendar'])).toEqual({
      key: 'googlecalendar',
      title: 'googlecalendar',
    })
    expect(ruleGroupOf({ remoteName: 'save_to_menu', route: 'POST /api/v1/menus/{id}/items' })).toEqual({
      key: 'menu',
      title: 'Menus',
    })
    expect(ruleGroupOf({ remoteName: 'listDatasets' })).toEqual({ key: 'dataset', title: 'Datasets' })
    expect(ruleGroupOf({ remoteName: 'getDatasetRun' })).toEqual({ key: 'dataset', title: 'Datasets' })
    expect(ruleGroupOf({ remoteName: 'list_categories' })).toEqual({ key: 'category', title: 'Categories' })
    expect(ruleGroupOf({ remoteName: 'search' })).toEqual({ key: 'other', title: 'Other' })
  })

  it('never pluralises the connection’s own name, nor a word with no plural', () => {
    const weather = { id: 'weather', title: 'weather' }
    expect(ruleGroupOf({ remoteName: 'get_weather' }, [], weather)).toEqual({ key: 'weather', title: 'Weather' })
    expect(ruleGroupOf({ remoteName: 'list_notes' }, [], { id: 'desk', title: 'Desk notes' })).toEqual({
      key: 'note',
      title: 'Notes',
    })
    expect(ruleGroupOf({ remoteName: 'getForecast' }, [], weather)).toEqual({ key: 'forecast', title: 'Forecasts' })
    expect(ruleGroupOf({ remoteName: 'get_weather' })).toEqual({ key: 'weather', title: 'Weather' })
    expect(ruleGroupOf({ remoteName: 'fetch_metadata' })).toEqual({ key: 'metadata', title: 'Metadata' })
    expect(ruleGroupOf({ remoteName: 'send_feedback', route: 'POST /api/feedback' })).toEqual({
      key: 'feedback',
      title: 'Feedback',
    })
    const { groups } = groupByRules(
      [
        { name: 'weather.get_weather', remoteName: 'get_weather' },
        { name: 'weather.weather_alerts', remoteName: 'weather_alerts' },
      ],
      [],
      weather,
    )
    expect(groups.map((group) => group.title)).toEqual(['Weather'])
  })

  it('sends groups of one to Other, last', () => {
    const { groups, assignments } = groupByRules([
      { name: 'x.listDatasets', remoteName: 'listDatasets' },
      { name: 'x.createDataset', remoteName: 'createDataset' },
      { name: 'x.getHealth', remoteName: 'getHealth' },
      { name: 'x.listDashboards', remoteName: 'listDashboards' },
      { name: 'x.deleteDashboard', remoteName: 'deleteDashboard' },
    ])
    expect(groups.map((group) => group.title)).toEqual(['Dashboards', 'Datasets', 'Other'])
    expect(assignments.find((entry) => entry.tool === 'x.getHealth')?.group).toBe('other')
  })

  it('reads what a tool does from its hints', () => {
    expect(effectOf({ annotations: { readOnlyHint: true } })).toBe('reads')
    expect(effectOf({ annotations: { destructiveHint: true } })).toBe('deletes')
    expect(effectOf({ annotations: {} })).toBe('changes')
  })

  it('counts a create or update a server marks destructive as a change, never a DELETE route', () => {
    const destructive = { destructiveHint: true }
    expect(effectOf({ annotations: destructive, remoteName: 'createDashboard' })).toBe('changes')
    expect(effectOf({ annotations: destructive, remoteName: 'upsert_dataset' })).toBe('changes')
    expect(effectOf({ annotations: destructive, remoteName: 'deleteDashboard' })).toBe('deletes')
    expect(effectOf({ annotations: destructive, remoteName: 'settle_account' })).toBe('deletes')
    expect(effectOf({ annotations: destructive, remoteName: 'setArchived', route: 'DELETE /items/{id}' })).toBe(
      'deletes',
    )
  })

  it('lets the owner’s own setting say what a tool does', () => {
    expect(actsAs({ annotations: {}, ownAccess: 'read' })).toBe('reads')
    expect(actsAs({ annotations: { readOnlyHint: true }, ownAccess: 'write' })).toBe('changes')
    expect(actsAs({ annotations: { destructiveHint: true }, remoteName: 'purge', ownAccess: 'write' })).toBe('deletes')
  })
})

describe('what a set of tools covers', () => {
  const titles: Record<string, string> = { mail: 'Mail', jobs: 'Jobs board' }
  const titleOf = (upstreamId: string) => titles[upstreamId] ?? upstreamId
  const group = (title: string) => ({ key: title.toLowerCase(), title })
  const tools = (upstreamId: string, filed: ({ key: string; title: string } | null)[]) =>
    filed.map((group) => ({ upstreamId, group }))

  it('names the groups of the tools, most tools first then by name, and nothing when there are none', () => {
    expect(
      coversOf(
        [
          ...tools('mail', [group('Threads'), group('Drafts'), group('Threads')]),
          ...tools('jobs', [group('Postings')]),
        ],
        titleOf,
      ),
    ).toEqual({ covers: ['Threads', 'Drafts', 'Postings'], more: 0 })
    expect(coversOf([], titleOf)).toEqual({ covers: [], more: 0 })
  })

  it('names the connection for a tool with no group of its own, or filed in Other', () => {
    expect(
      coversOf(
        [...tools('jobs', [null, OTHER, group('Postings')]), ...tools('mail', [OTHER]), ...tools('new', [null])],
        titleOf,
      ),
    ).toEqual({ covers: ['Jobs board', 'Mail', 'new', 'Postings'], more: 0 })
  })

  it('names at most COVERS_MAX and counts the rest', () => {
    expect(COVERS_MAX).toBe(6)
    const many = tools(
      'mail',
      [...'abcdefgh'].map((letter) => group(`Group ${letter}`)),
    )
    expect(coversOf([...many, ...tools('mail', [group('Group h')])], titleOf)).toEqual({
      covers: ['Group h', 'Group a', 'Group b', 'Group c', 'Group d', 'Group e'],
      more: 2,
    })
  })
})
