import { describe, expect, it } from 'vitest'
import { arrivalsOf, groupLine, onAccessOf, regroupLine, toolStateOf } from './groups.rules'

describe('tool groups', () => {
  it('says what a group holds, leaving out effects it has none of', () => {
    expect(groupLine({ tools: 12, effects: { reads: 8, changes: 3, deletes: 1 } })).toBe(
      '12 tools · 8 read · 3 change · 1 delete',
    )
    expect(groupLine({ tools: 1, effects: { reads: 1, changes: 0, deletes: 0 } })).toBe('1 tool · 1 read')
  })

  it('says why a tool is on or off, and what the owner can do', () => {
    expect(toolStateOf({ access: 'off', offBy: 'group', needsWrite: true })).toMatchObject({
      on: false,
      action: 'turn-on',
    })
    expect(toolStateOf({ access: 'read', offBy: null, needsWrite: false })).toMatchObject({
      on: true,
      action: 'follow',
    })
    expect(toolStateOf({ access: null, offBy: null, needsWrite: false })).toMatchObject({
      on: true,
      action: 'turn-off',
    })
    expect(onAccessOf({ needsWrite: true })).toBe('write')
  })

  it('shows a regroup tool by tool: where each comes from, without the ones that stay', () => {
    const proposal = {
      before: [
        { key: 'menus', title: 'Menus', off: false, tools: ['x.list_menus', 'x.board_tips'] },
        { key: 'other', title: 'Other', off: false, tools: ['x.get_invoice', 'x.match_payment', 'x.pinned'] },
      ],
      after: [
        { key: 'menus', title: 'Menus', purpose: null, off: false, tools: ['x.list_menus', 'x.board_tips'] },
        {
          key: 'billing',
          title: 'Billing',
          purpose: null,
          off: false,
          tools: ['x.get_invoice', 'x.match_payment', 'x.pinned'],
        },
      ],
      kept: ['x.pinned'],
      moves: 2,
    }
    const [menus, type] = arrivalsOf(proposal)
    expect(menus?.tools).toEqual([
      { name: 'x.list_menus', from: null },
      { name: 'x.board_tips', from: null },
    ])
    expect(type?.tools).toEqual([
      { name: 'x.get_invoice', from: 'Other' },
      { name: 'x.match_payment', from: 'Other' },
    ])
    expect(regroupLine(proposal)).toBe('2 groups · 2 tools move')
    expect(regroupLine({ ...proposal, moves: 0 })).toBe('Nothing would change')
    expect(regroupLine({ ...proposal, moves: 1 })).toBe('2 groups · 1 tool moves')
  })
})
