/**
 * A stand-in OpenAI-compatible server: `/models`, and `/chat/completions` that answers the gateway's three asks by
 * what the system message says: name groups, name groups for leftovers, choose labels, or the test's `{"ok": true}`. `asks` records them.
 */
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'

export const LLM_KEY = 'llm-test-key'

export const startLlm = async () => {
  const asks: { model: string; system: string; user: string }[] = []
  /** What the writer proposes for a connection: set by a test. */
  type Group = { key: string; title: string; purpose: string; tools: string[] }
  /** `more` is what the writer proposes for leftovers (its second round); `failMore` makes that round fail. */
  const state = { groups: [] as Group[], more: [] as Group[], failMore: false }
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.headers.get('authorization') !== `Bearer ${LLM_KEY}`)
        return Response.json({ error: { message: 'bad key' } }, { status: 401 })
      if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'writer-1' }, { id: 'decider-1' }] })
      if (url.pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 })
      const body = (await request.json()) as { model: string; messages: { role: string; content: string }[] }
      const system = body.messages.find((message) => message.role === 'system')?.content ?? ''
      const user = body.messages.find((message) => message.role === 'user')?.content ?? ''
      asks.push({ model: body.model, system, user })
      const reply = (content: unknown) =>
        Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }] })
      if (system.startsWith('You choose')) {
        const { questions } = JSON.parse(user) as {
          questions: Record<string, { question: string; labels: Record<string, string> }>
        }
        // Picks the group whose tool list names the tool in the question, else the first label
        return reply(
          Object.fromEntries(
            Object.entries(questions).map(([name, question]) => {
              const labels = Object.keys(question.labels)
              const found = [...state.groups, ...state.more].find(
                (group) => labels.includes(group.key) && group.tools.some((tool) => question.question.includes(tool)),
              )
              return [
                name,
                found
                  ? found.key
                  : (labels.find((label) => label === 'menus') ??
                    labels.find((label) => label === 'other') ??
                    labels[0]),
              ]
            }),
          ),
        )
      }
      if (system.includes('left without a group'))
        return state.failMore
          ? Response.json({ error: { message: 'overloaded' } }, { status: 500 })
          : reply({ groups: state.more.map(({ tools: _, ...group }) => group) })
      if (system.includes('group')) return reply({ groups: state.groups.map(({ tools: _, ...group }) => group) })
      return reply({ ok: true })
    },
  })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    asks,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
