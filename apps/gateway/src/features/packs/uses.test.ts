import { describe, expect, it } from 'vitest'
import { likelyUses, routesIn, usesIn } from './uses.js'

const tools = [
  {
    name: 'cookbook.seasonal_picks',
    upstreamId: 'cookbook',
    remoteName: 'seasonal_picks',
    route: 'GET /api/v1/explore/seasonal',
  },
  {
    name: 'cookbook.research_recipes',
    upstreamId: 'cookbook',
    remoteName: 'research_recipes',
    route: 'GET /api/v1/explore/recipes',
  },
  { name: 'cookbook.get_recipe', upstreamId: 'cookbook', remoteName: 'get_recipe', route: 'GET /api/v1/recipes/{id}' },
  { name: 'cookbook.list_menus', upstreamId: 'cookbook', remoteName: 'list_menus', route: 'GET /api/v1/boards' },
  { name: 'cookbook.create_menu', upstreamId: 'cookbook', remoteName: 'create_menu', route: 'POST /api/v1/boards' },
  { name: 'notes.list_menus', upstreamId: 'notes', remoteName: 'list_menus', route: 'GET /api/v1/boards' },
]

const PLAYBOOK = `# Plan a dinner
1. **Measure the norm.** \`GET /api/v1/explore/seasonal?category=<slug>\` (MCP: \`seasonal_picks\`).
2. **Study real dinners.** \`GET /api/v1/explore/recipes?q=soup\` for the best examples.
3. Open one: \`/api/v1/recipes/123\`. Keep them on a menu: list_menus.`

describe('what a playbook uses', () => {
  it('reads the routes it calls, without their queries', () => {
    expect(routesIn(PLAYBOOK)).toContainEqual({ method: 'GET', path: '/api/v1/explore/seasonal' })
    expect(routesIn(PLAYBOOK)).toContainEqual({ method: null, path: '/api/v1/recipes/123' })
  })

  it('finds named tools and tools by route, in the order the text uses them', () => {
    expect(usesIn(PLAYBOOK, 'cookbook', tools)).toEqual([
      { tool: 'cookbook.seasonal_picks', reason: 'named' },
      { tool: 'cookbook.research_recipes', reason: 'route' },
      { tool: 'cookbook.get_recipe', reason: 'route' },
      { tool: 'cookbook.list_menus', reason: 'named' },
    ])
  })

  it('counts only the playbook’s own upstream: every archive has list_menus', () => {
    expect(usesIn(PLAYBOOK, 'cookbook', tools).map((use) => use.tool)).not.toContain('notes.list_menus')
  })

  it('does not match a method the text contradicts', () => {
    expect(usesIn('`DELETE /api/v1/boards`', 'cookbook', tools)).toEqual([])
    expect(usesIn('`POST /api/v1/boards` makes one', 'cookbook', tools)).toEqual([
      { tool: 'cookbook.create_menu', reason: 'route' },
    ])
  })

  it('does not read a name inside a path as named', () => {
    expect(usesIn('`GET /api/v1/recipes/get_recipe`', 'cookbook', tools)).toEqual([
      { tool: 'cookbook.get_recipe', reason: 'route' },
    ])
  })

  it('does not take a longer name for a shorter one', () => {
    expect(usesIn('use get_recipes_v2 here', 'cookbook', tools)).toEqual([])
  })

  it('suggests by meaning only what is not found or in already', () => {
    expect(
      likelyUses(
        ['cookbook.seasonal_picks', 'cookbook.create_menu', 'notes.list_menus'],
        [{ tool: 'cookbook.seasonal_picks', reason: 'named' }],
        new Set(['notes.list_menus']),
      ),
    ).toEqual([{ tool: 'cookbook.create_menu', reason: 'meaning' }])
  })
})
