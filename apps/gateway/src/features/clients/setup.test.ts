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

  it('gives an OAuth client locked to a pack claude.ai at that pack’s address, and one of the root the root', () => {
    const [atPack] = surfacesOf({ origin: 'https://gw.example.com', kind: 'oauth', oauth: true, pack: 'desk' })
    expect(atPack?.snippet).toBe('Name: Yardhand\nURL:  https://gw.example.com/p/desk/mcp')
    const [atRoot] = surfacesOf({ origin: 'https://gw.example.com', kind: 'oauth', oauth: true })
    expect(atRoot?.snippet).toBe('Name: Yardhand\nURL:  https://gw.example.com/mcp')
  })

  it('hands out a pack’s own address in every snippet, and no claude.ai: a pack’s setup is for a key', () => {
    const surfaces = surfacesOf({ origin: 'https://gw.example.com', kind: 'key', oauth: true, pack: 'desk' })
    expect(surfaces.map((surface) => surface.id)).toEqual(['claude-code', 'cursor', 'codex', 'curl', 'typescript'])
    expect(surfaces[0]?.snippet).toContain('--scope user gw-desk https://gw.example.com/p/desk/mcp')
    expect(surfaces[0]?.note).toContain('gw-desk')
    expect(JSON.parse(surfaces[1]?.snippet ?? '{}').mcpServers['gw-desk'].url).toBe('https://gw.example.com/p/desk/mcp')
    expect(surfaces[2]?.snippet).toContain('[mcp_servers.gw-desk]\nurl = "https://gw.example.com/p/desk/mcp"')
    expect(surfaces[3]?.snippet).toContain('"https://gw.example.com/p/desk/api/tools?q=')
    expect(surfaces[3]?.snippet).toContain('https://gw.example.com/p/desk/api/calls')
    expect(surfaces[3]?.note).toContain('/p/desk/api/tools/openapi.json')
    expect(surfaces[4]?.snippet).toContain("createGateway({ url: 'https://gw.example.com/p/desk'")
    // Nothing in it points at the root
    for (const surface of surfaces)
      expect(surface.snippet.replaceAll('https://gw.example.com/p/desk', '')).not.toContain('gw.example.com')
  })

  it('gives a key with several packs one server per pack, the same key in each', () => {
    const surfaces = surfacesOf({
      origin: 'https://mcp.example.test',
      kind: 'key',
      oauth: false,
      packs: ['acme', 'support'],
    })
    expect(surfaces[0]?.snippet).toContain('gw-acme https://mcp.example.test/p/acme/mcp')
    expect(surfaces[0]?.snippet).toContain('gw-support https://mcp.example.test/p/support/mcp')
    expect(Object.keys(JSON.parse(surfaces[1]?.snippet ?? '{}').mcpServers)).toEqual(['gw-acme', 'gw-support'])
    expect(surfaces[2]?.snippet).toContain('[mcp_servers.gw-support]')
    // One pack is still just gw
    expect(surfacesOf({ origin: 'https://x.test', kind: 'key', oauth: false, packs: ['one'] })[0]?.snippet).toContain(
      ' gw https://x.test/mcp',
    )
  })
})
