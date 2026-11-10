/**
 * A fake MCP upstream on a random local port, behind a bearer token: `echo` (read-only) and `shout` (changes things),
 * a manual (the Skills extension, with a reference file), two prompts and a resource template (`fixture://notes/{id}`).
 */
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import {
  acceptedContent,
  createMcpHandler,
  inputRequired,
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/server'
import { memorySkillFiles, SkillCatalog } from '@modelcontextprotocol/server/ext/skills'
import { z } from 'zod'

/**
 * `asking` adds tools that ask mid-call (`delete_menus`, `summarize`) and one that reports progress (`count_slowly`);
 * `greeting` adds `greet` (`to` and `from`; `state.greetFrom = false` drops `from`, as an upstream renaming an input).
 */
export const startUpstream = async ({
  token,
  asking = false,
  greeting = false,
}: {
  token: string
  asking?: boolean
  greeting?: boolean
}) => {
  const state = {
    echoDescription: 'Echoes the text back.',
    echoRoute: 'GET /api/v1/echo',
    whisper: false,
    greetFrom: true,
    calls: 0,
    manual: 'Start with echo for anything you want said back.',
    playbookDescription: 'Says a topic back, loudly.',
  }
  const factory = async () => {
    const server = new McpServer(
      { name: 'fixture', version: '1.0.0' },
      {
        instructions: 'Fixture upstream: echo reads, shout writes.',
        // As agent-api-kit servers do: clients may keep the lists for an hour
        cacheHints: {
          'tools/list': { ttlMs: 3_600_000, cacheScope: 'private' },
          'prompts/list': { ttlMs: 3_600_000, cacheScope: 'private' },
          'resources/list': { ttlMs: 3_600_000, cacheScope: 'private' },
        },
      },
    )
    server.registerTool(
      'echo',
      {
        description: state.echoDescription,
        inputSchema: z.object({ text: z.string() }),
        annotations: { readOnlyHint: true },
        // The route behind it, as agent-api-kit 1.7.0 publishes it
        _meta: { 'com.example.server/route': state.echoRoute },
      },
      // Readable text and typed JSON beside it, as the archives answer
      async ({ text }) => {
        state.calls++
        return { content: [{ type: 'text', text }], structuredContent: { echoed: text, length: text.length } }
      },
    )
    server.registerTool(
      'shout',
      { description: 'Shouts the text and remembers it.', inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => {
        state.calls++
        return { content: [{ type: 'text', text: text.toUpperCase() }] }
      },
    )
    const greet = async (args: { to: string; from?: string; sender?: string }) => ({
      content: [{ type: 'text' as const, text: `Hello ${args.to}, from ${args.from ?? args.sender}` }],
    })
    const greetMeta = { description: 'Greets someone, from someone.', annotations: { readOnlyHint: true } }
    if (greeting && state.greetFrom)
      server.registerTool('greet', { ...greetMeta, inputSchema: z.object({ to: z.string(), from: z.string() }) }, greet)
    else if (greeting)
      server.registerTool(
        'greet',
        { ...greetMeta, inputSchema: z.object({ to: z.string(), sender: z.string() }) },
        greet,
      )
    if (state.whisper)
      server.registerTool(
        'whisper',
        { description: 'Whispers.', inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: true } },
        async ({ text }) => ({ content: [{ type: 'text', text: text.toLowerCase() }] }),
      )
    if (asking) {
      server.registerTool(
        'delete_menus',
        {
          description: 'Deletes menus, after asking.',
          inputSchema: z.object({ count: z.number() }),
          annotations: { readOnlyHint: true },
        },
        async ({ count }, ctx) => {
          if (!ctx.mcpReq.inputResponses)
            return inputRequired({
              inputRequests: {
                confirm: inputRequired.elicit({
                  message: `Delete ${count} menus?`,
                  requestedSchema: z.object({ confirm: z.boolean() }),
                }),
              },
              requestState: `count:${count}`,
            })
          const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm') as { confirm?: boolean } | undefined
          // Its own state comes back as it was sent, through the gateway
          const state = ctx.mcpReq.requestState()
          return {
            content: [{ type: 'text', text: `${answer?.confirm ? `Deleted ${count} menus` : 'Kept them'} (${state})` }],
          }
        },
      )
      server.registerTool(
        'summarize',
        {
          description: 'Summarizes, with the caller’s model.',
          inputSchema: z.object({}),
          annotations: { readOnlyHint: true },
        },
        async (_args, ctx) =>
          ctx.mcpReq.inputResponses
            ? { content: [{ type: 'text', text: 'summarized' }] }
            : inputRequired({
                inputRequests: {
                  draft: inputRequired.createMessage({
                    messages: [{ role: 'user', content: { type: 'text', text: 'Summarize this.' } }],
                    maxTokens: 50,
                  }),
                },
              }),
      )
      server.registerTool(
        'count_slowly',
        { description: 'Counts to three, saying so.', inputSchema: z.object({}), annotations: { readOnlyHint: true } },
        async (_args, ctx) => {
          const token = ctx.mcpReq._meta?.progressToken
          for (let step = 1; step <= 3; step++) {
            if (token !== undefined)
              await ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken: token, progress: step, total: 3, message: `step ${step}` },
              })
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          return { content: [{ type: 'text', text: 'counted' }] }
        },
      )
    }
    server.registerPrompt(
      'say-it-back',
      {
        title: 'Say it back',
        description: state.playbookDescription,
        argsSchema: z.object({ topic: z.string().describe('What to say.') }),
      },
      ({ topic }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `Use echo with "${topic}", then shout it.` } }],
      }),
    )
    server.registerPrompt('warm-up', { description: 'A first call to check the server.' }, () => ({
      messages: [{ role: 'user', content: { type: 'text', text: 'Check the server: `GET /api/v1/echo?text=hello`.' } }],
    }))
    server.registerResource(
      'note',
      new ResourceTemplate('fixture://notes/{id}', { list: undefined }),
      { title: 'A note', description: 'One note by its id.', mimeType: 'text/plain' },
      async (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Note ${id}` }] }),
    )
    const skills = await SkillCatalog.load(
      memorySkillFiles({
        'fixture/SKILL.md': `---\nname: fixture\ndescription: How to use the fixture server.\n---\n\n# Fixture\n\n${state.manual}\n\nMore in references/notes.md.\n`,
        'fixture/references/notes.md': '# Notes\n\nNotes are at fixture://notes/{id}.\n',
      }),
      { onWarning: () => {} },
    )
    skills.attach(server)
    return server
  }
  const handler = createMcpHandler(factory, { responseMode: 'auto' })
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      if (request.headers.get('authorization') !== `Bearer ${token}`)
        return new Response('unauthorized', { status: 401 })
      // A file on the upstream's own host, behind the same token: what a tool's links point at
      if (new URL(request.url).pathname === '/files/a.txt')
        return new Response('file body', { headers: { 'content-type': 'text/plain' } })
      // A page behind a sign-in wall on another host, as Cloudflare Access answers
      if (new URL(request.url).pathname === '/app/page')
        return Response.redirect('https://sign-in.example.com/login?to=app', 302)
      if (new URL(request.url).pathname === '/files/record.json')
        return Response.json({ next: `${new URL(request.url).origin}/files/a.txt`, padding: 'x'.repeat(5000) })
      return handler.fetch(request)
    },
  })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    state,
    /** Cuts every open connection, as a restart or a network blip would. */
    drop: () => (server as unknown as { closeAllConnections: () => void }).closeAllConnections(),
    /** Announces that its tools, prompts and resources changed, to whoever listens. */
    announce: () => {
      handler.notify.toolsChanged()
      handler.notify.promptsChanged()
      handler.notify.resourcesChanged()
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
