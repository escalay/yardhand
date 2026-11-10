import { describe, expect, it } from 'vitest'
import { messageText, slashCommandOf } from './playbooks.rules'

describe('playbooks', () => {
  it('reads as the slash command Claude Code shows', () => {
    expect(slashCommandOf('cookbook-plan-a-dinner', 'gw')).toBe('/mcp__gw__cookbook-plan-a-dinner')
  })

  it('turns a prompt message into text the owner can read', () => {
    expect(messageText({ role: 'user', content: { type: 'text', text: '# Steps' } })).toBe('# Steps')
    expect(messageText({ role: 'user', content: { type: 'resource', resource: { uri: 'x://1', text: 'body' } } })).toBe(
      'body',
    )
    expect(messageText({ role: 'user', content: { type: 'image' } })).toBe('*image content*')
  })
})
