/**
 * Paste-ready setup for each place an agent or script runs, built on the server so the app, the CLI and agents all
 * hand out the same text. The key is never in it: `<YOUR_KEY>` stands in, and the app swaps in the key it was just
 * shown, once.
 */

export const KEY_PLACEHOLDER = '<YOUR_KEY>'

export type Surface = {
  id: 'claude-code' | 'cursor' | 'codex' | 'claude-ai' | 'curl' | 'typescript'
  title: string
  /** Where the snippet goes. */
  where: string
  format: 'shell' | 'json' | 'toml' | 'text' | 'typescript'
  snippet: string
  note: string | null
}

/**
 * The name agents register the gateway under: short, because hosts build names from it (Claude Code's playbook
 * commands read `/mcp__gw__cookbook-plan-a-dinner`, its tools `mcp__gw__search_tools`).
 */
export const SERVER_NAME = 'gw'

/**
 * The servers an agent adds: the gateway as `gw`, or for a key with several packs, one server per pack
 * (`gw-<pack>` at `/mcp/p/<pack>`), each turned on or off per project. One pack is still just `gw`.
 */
export const serversOf = (origin: string, packs: string[] = []) =>
  packs.length > 1
    ? packs.map((pack) => ({ name: `${SERVER_NAME}-${pack}`, url: `${origin}/mcp/p/${pack}` }))
    : [{ name: SERVER_NAME, url: `${origin}/mcp` }]

export const surfacesOf = ({
  origin,
  kind,
  oauth,
  packs = [],
}: {
  origin: string
  kind: 'key' | 'oauth'
  /** Can agents sign in with OAuth here (claude.ai connectors)? */
  oauth: boolean
  /** The packs a pack key opens, the default first. */
  packs?: string[]
}): Surface[] => {
  const mcp = `${origin}/mcp`
  const name = SERVER_NAME
  const servers = serversOf(origin, packs)
  const claudeAi: Surface = {
    id: 'claude-ai',
    title: 'claude.ai',
    where: 'claude.ai → Settings → Connectors → Add custom connector',
    format: 'text',
    snippet: `Name: Yardhand\nURL:  ${mcp}`,
    note: 'No key: claude.ai signs in with OAuth and you approve it once. It shows up under Agents after its first call.',
  }
  if (kind === 'oauth') return oauth ? [claudeAi] : []
  return [
    {
      id: 'claude-code',
      title: 'Claude Code',
      where: 'A terminal on the machine that runs Claude Code',
      format: 'shell',
      snippet: servers
        .map(
          (server) =>
            `claude mcp add --transport http --scope user ${server.name} ${server.url} \\\n  --header "Authorization: Bearer ${KEY_PLACEHOLDER}"`,
        )
        .join('\n\n'),
      note:
        servers.length > 1
          ? `One server per pack, the same key in each: turn one off for a project in /mcp. Plain ${mcp} serves the default, ${packs[0]}.`
          : `Then /mcp in Claude Code lists ${name} as connected, and its playbooks show as /mcp__${name}__… commands.`,
    },
    {
      id: 'cursor',
      title: 'Cursor',
      where: '~/.cursor/mcp.json',
      format: 'json',
      snippet: JSON.stringify(
        {
          mcpServers: Object.fromEntries(
            servers.map((server) => [
              server.name,
              { url: server.url, headers: { Authorization: `Bearer ${KEY_PLACEHOLDER}` } },
            ]),
          ),
        },
        null,
        2,
      ),
      note: 'Merge it into mcpServers if the file already has other servers.',
    },
    {
      id: 'codex',
      title: 'Codex',
      where: '~/.codex/config.toml, with the key in your shell profile',
      format: 'toml',
      snippet: servers
        .map((server) => `[mcp_servers.${server.name}]\nurl = "${server.url}"\nbearer_token_env_var = "YARDHAND_KEY"`)
        .join('\n\n'),
      note: `And in ~/.zshrc: export YARDHAND_KEY="${KEY_PLACEHOLDER}"`,
    },
    ...(oauth ? [claudeAi] : []),
    {
      id: 'curl',
      title: 'curl',
      where: 'Any shell',
      format: 'shell',
      snippet: [
        `curl -s "${origin}/api/tools?q=what+you+want+to+do" \\\n  -H "Authorization: Bearer ${KEY_PLACEHOLDER}"`,
        `curl -s ${origin}/api/calls -H "Authorization: Bearer ${KEY_PLACEHOLDER}" \\\n  -H 'content-type: application/json' -d '{"tool": "<name>", "arguments": {}}'`,
      ].join('\n\n'),
      note: 'Every tool is also an OpenAPI operation at /api/tools/openapi.json.',
    },
    {
      id: 'typescript',
      title: 'TypeScript',
      where: 'A script, with @yardhand/client from the Yardhand repo',
      format: 'typescript',
      snippet: [
        "import { createGateway, textOf } from '@yardhand/client'",
        '',
        `const gateway = createGateway({ url: '${origin}', key: process.env.YARDHAND_KEY! })`,
        "const [tool] = await gateway.tools.search('what you want to do')",
        'console.log(textOf(await gateway.call(tool.name, {})))',
      ].join('\n'),
      note: `export YARDHAND_KEY="${KEY_PLACEHOLDER}" before running it.`,
    },
  ]
}
