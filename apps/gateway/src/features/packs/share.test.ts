import { describe, expect, it } from 'vitest'
import { KEY_APPS, KEY_PLACEHOLDER } from '../clients/setup.js'
import { shareMessage } from './share.js'

const KEY = 'gw_key-for-sam'
const share = {
  pack: { name: 'loud', title: 'Loud', description: 'Say things back, loudly.\n\nStart with echo.' },
  person: 'Sam',
  scope: 'read' as const,
  expiresAt: '2026-12-21T10:00:00.000Z',
  app: 'claude-code' as const,
  origin: 'https://gw.example.com',
  key: KEY,
}
const END = 'The key is yours alone: keep it to yourself. When it stops working, ask me for a new invite.'

describe('the message that shares a pack', () => {
  it('says what the pack is, what they can do, until when, and the setup for their app with the key in it', () => {
    expect(shareMessage(share)).toBe(
      [
        "Hi Sam, I'm sharing Loud with you.",
        'Say things back, loudly.',
        'You can read with it, but not change anything. It works until 21 Dec 2026.',
        'Add it to Claude Code (a terminal on the machine that runs Claude Code):',
        `claude mcp add --transport http --scope user gw-loud https://gw.example.com/p/loud/mcp \\\n  --header "Authorization: Bearer ${KEY}"`,
        'Then /mcp in Claude Code lists gw-loud as connected, and its playbooks show as /mcp__gw-loud__… commands.',
        END,
      ].join('\n\n'),
    )
  })

  it('puts the key wherever the setup had its placeholder, for every app a key is pasted into', () => {
    for (const app of KEY_APPS) {
      const message = shareMessage({ ...share, app })
      expect([app, message.includes(KEY_PLACEHOLDER), message.includes(KEY)]).toEqual([app, false, true])
      expect(message).toContain('https://gw.example.com/p/loud')
    }
    // Codex reads the key from the shell profile: the note carries it
    const codex = shareMessage({ ...share, app: 'codex' })
    expect(codex).toContain('Add it to Codex (~/.codex/config.toml, with the key in your shell profile):')
    expect(codex).toContain('[mcp_servers.gw-loud]\nurl = "https://gw.example.com/p/loud/mcp"')
    expect(codex).toContain(`And in ~/.zshrc: export YARDHAND_KEY="${KEY}"`)
    // curl sends it with both requests
    expect(shareMessage({ ...share, app: 'curl' }).split(`Bearer ${KEY}`)).toHaveLength(3)
  })

  it('gives the address and the bearer line when the app is not known', () => {
    expect(shareMessage({ ...share, app: null })).toBe(
      [
        "Hi Sam, I'm sharing Loud with you.",
        'Say things back, loudly.',
        'You can read with it, but not change anything. It works until 21 Dec 2026.',
        `Its address is https://gw.example.com/p/loud/mcp and your key is ${KEY}. Add it to your app as an MCP server and send the key as a bearer token: Authorization: Bearer ${KEY}`,
        END,
      ].join('\n\n'),
    )
  })

  it('gives the same for an app with no setup at a pack’s address', () => {
    expect(shareMessage({ ...share, app: 'claude-ai' })).toBe(shareMessage({ ...share, app: null }))
  })

  it('says when they can change things, and when nothing ends it', () => {
    expect(shareMessage({ ...share, scope: 'write' })).toContain(
      'You can read and change things with it. It works until 21 Dec 2026.',
    )
    expect(shareMessage({ ...share, expiresAt: null })).toContain(
      'You can read with it, but not change anything. It works until I end it.',
    )
  })

  it('says nothing of what the pack is for when the owner wrote nothing', () => {
    expect(shareMessage({ ...share, app: null, pack: { ...share.pack, description: ' \n' } }).split('\n\n')).toEqual([
      "Hi Sam, I'm sharing Loud with you.",
      'You can read with it, but not change anything. It works until 21 Dec 2026.',
      expect.stringContaining('Its address is https://gw.example.com/p/loud/mcp'),
      END,
    ])
  })
})
