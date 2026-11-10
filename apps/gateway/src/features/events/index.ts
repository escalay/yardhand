/**
 * `GET /api/events`: a server-sent event stream for the owner. `call` for every call in the log, `sync` when an
 * upstream's tools were read again, `upstream` when one goes live or starts failing; a `ping` every 25 seconds keeps
 * proxies from closing it.
 */
import { createRoute, z } from '@hono/zod-openapi'
import { streamSSE } from 'hono/streaming'
import { problemResponses } from '../../kit/index.js'
import { requireOwner } from '../clients/principals.js'
import type { Feature } from '../index.js'

export const PATH = '/api/events'
const TAG = 'Events'
const PING_MS = 25_000

const route = createRoute({
  method: 'get',
  path: PATH,
  operationId: 'streamEvents',
  tags: [TAG],
  summary: 'Live events',
  description:
    'Server-sent events, as they happen (owner only): `call` (one call, as in the log), `sync` (what a sync changed), `upstream` (status changed) and `ping`. Reconnect on close; nothing is replayed, so read the log for what you missed.',
  responses: {
    200: {
      description: 'An event stream.',
      content: {
        'text/event-stream': {
          schema: z.string().openapi('EventStream', {
            description: 'Lines of `event: <type>` and `data: <JSON>`, one blank line between events.',
            example: 'event: call\ndata: {"id":"call_…","tool":"cookbook.search_recipes","status":"ok"}\n\n',
          }),
        },
      },
    },
    ...problemResponses(401, 403),
  },
})

export const feature: Feature = {
  name: 'events',
  tag: { name: TAG, description: 'What happens in the gateway, live.' },
  migrations: [],
  register: (app, { events }) => {
    app.openapi(route, (c) => {
      requireOwner(c)
      return streamSSE(c, async (stream) => {
        let open = true
        const stop = events.subscribe((event) => {
          if (open) void stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) }).catch(() => {})
        })
        const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => {}), PING_MS)
        await stream.writeSSE({ event: 'ping', data: '{}' })
        await new Promise<void>((resolve) => stream.onAbort(resolve))
        open = false
        clearInterval(ping)
        stop()
      }) as never
    })
  },
  tools: [],
}
