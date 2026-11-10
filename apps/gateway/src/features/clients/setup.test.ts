import { describe, expect, it } from 'vitest'
import { KEY_PLACEHOLDER, surfacesOf } from './setup.js'

describe('setup snippets', () => {
  it('gives a key client every surface, the key only as a placeholder', () => {
    const surfaces = surfacesOf({ origin: 'https://mcp.example.test', kind: 'key', oauth: true })
    expect(surfaces.map((surface) => surface.id)).toEqual([
      'claude-code',
      'cursor',
      'codex',
      'claude-ai',
      'curl',
      'typescript',
    ])
    const cursor = JSON.parse(surfaces[1]?.snippet ?? '{}')
    expect(cursor.mcpServers.gw).toEqual({
      url: 'https://mcp.example.test/mcp',
      headers: { Authorization: `Bearer ${KEY_PLACEHOLDER}` },
    })
    expect(surfaces[2]?.snippet).toContain('bearer_token_env_var = "YARDHAND_KEY"')
    // Short, so hosts' names stay readable: /mcp__gw__cookbook-plan-a-dinner
    expect(surfaces[0]?.snippet).toContain('--scope user gw https://mcp.example.test/mcp')
    expect(surfaces[2]?.snippet).toContain('[mcp_servers.gw]')
  })

  it('leaves claude.ai out without OAuth, and gives an OAuth client only claude.ai', () => {
    expect(surfacesOf({ origin: 'http://localhost:4400', kind: 'key', oauth: false }).map((s) => s.id)).not.toContain(
      'claude-ai',
    )
    expect(surfacesOf({ origin: 'http://localhost:4400', kind: 'oauth', oauth: true }).map((s) => s.id)).toEqual([
      'claude-ai',
    ])
  })

  it('gives a key with several packs one server per pack, the same key in each', () => {
    const surfaces = surfacesOf({
      origin: 'https://mcp.example.test',
      kind: 'key',
      oauth: false,
      packs: ['acme', 'support'],
    })
    expect(surfaces[0]?.snippet).toContain('gw-acme https://mcp.example.test/mcp/p/acme')
    expect(surfaces[0]?.snippet).toContain('gw-support https://mcp.example.test/mcp/p/support')
    expect(Object.keys(JSON.parse(surfaces[1]?.snippet ?? '{}').mcpServers)).toEqual(['gw-acme', 'gw-support'])
    expect(surfaces[2]?.snippet).toContain('[mcp_servers.gw-support]')
    // One pack is still just gw
    expect(surfacesOf({ origin: 'https://x.test', kind: 'key', oauth: false, packs: ['one'] })[0]?.snippet).toContain(
      ' gw https://x.test/mcp',
    )
  })
})
