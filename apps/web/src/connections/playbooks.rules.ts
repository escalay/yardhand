/** How playbooks read to the owner: the slash command a host shows, and a message as text. */

/** `/mcp__gw__cookbook-plan-a-dinner`: how Claude Code lists a playbook, for the name agents register the gateway under. */
export const slashCommandOf = (name: string, serverName: string) => `/mcp__${serverName}__${name}`

type Message = { role?: string; content?: { type?: string; text?: string; resource?: { uri?: string; text?: string } } }

/** One prompt message as Markdown: its text, an embedded resource's text, or what it is. */
export const messageText = (message: unknown) => {
  const content = (message as Message).content
  if (content?.type === 'text') return content.text ?? ''
  if (content?.type === 'resource') return content.resource?.text ?? `*Resource ${content.resource?.uri ?? ''}*`
  return `*${content?.type ?? 'unknown'} content*`
}
