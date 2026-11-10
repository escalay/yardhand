/**
 * An MCP upstream that only takes OAuth tokens: a kit app with its own OAuth server (registration, PKCE consent, ES256
 * tokens). The owner is whoever sends `x-test-owner`, standing in for the upstream's own sign-in.
 */
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { createRoute, z } from '@hono/zod-openapi'
import {
  createAgentApi,
  createOAuth,
  generateOAuthKey,
  HAL_JSON,
  memoryOAuthStore,
  problemResponses,
} from '../../src/kit/index.js'
import { inProcess, mcpServerFactory, mcpTool, mountMcp } from '../../src/kit/mcp/index.js'

export const startOAuthUpstream = async () => {
  const oauth = createOAuth({
    name: 'Secure fixture',
    signingKey: await generateOAuthKey(),
    store: memoryOAuthStore(),
    owner: async (c) => c.req.header('x-test-owner') ?? null,
  })
  const app = createAgentApi({
    title: 'Secure fixture',
    version: '1',
    description: 'Needs OAuth.',
    tags: [{ name: 'Ping', description: 'Ping.' }],
    auth: { realm: 'secure', keys: new Map() },
    oauth,
  })
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/ping',
      operationId: 'ping',
      tags: ['Ping'],
      summary: 'Ping',
      description: 'Answers pong to a caller with a token.',
      responses: {
        200: {
          content: {
            [HAL_JSON]: { schema: z.object({ pong: z.boolean() }).openapi('Pong', { description: 'Pong.' }) },
          },
          description: 'Pong.',
        },
        ...problemResponses(401),
      },
    }),
    (c) => c.json({ pong: true }, 200),
  )
  const ping = mcpTool({
    name: 'ping',
    title: 'Ping',
    description: 'Answers pong.',
    input: z.object({}),
    annotations: { readOnlyHint: true },
    call: () => ({ path: '/api/ping' }),
    summarize: () => 'pong',
  })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const { port } = server.address() as AddressInfo
  mountMcp(app, {
    factory: mcpServerFactory({
      info: { name: 'secure', version: '1' },
      instructions: 'Secure fixture.',
      tools: [ping],
      callApi: inProcess(app),
    }),
    allowedHostnames: ['127.0.0.1', 'localhost'],
  })
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
