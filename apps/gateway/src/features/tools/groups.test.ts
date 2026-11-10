import { describe, expect, it } from 'vitest'
import { actsAs, effectOf, groupByRules, ruleGroupOf } from './groups.js'

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
