/** A fake REST API with an OpenAPI 3.1 spec, behind an `x-api-key` header, on a random local port. */
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Fixture REST', version: '1' },
  servers: [{ url: '/v1' }],
  components: {
    schemas: {
      ItemInput: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', description: 'Its name.' } },
      },
    },
  },
  paths: {
    '/items/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'getItem',
        summary: 'One item',
        parameters: [
          { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
          { name: 'limit', in: 'query', required: true, schema: { type: 'integer', default: 10 } },
        ],
        responses: { 200: { description: 'ok' } },
      },
      delete: {
        operationId: 'deleteItem',
        summary: 'Delete an item',
        // Long, as real specs are, so the app's screens are tested against it
        description:
          'Removes the item for good, with its history, its attachments and every link that points at it. Nothing can bring it back afterwards, so check the id twice; the full rules are at https://items.example.test/docs/reference/items/delete-an-item-and-everything-attached-to-it-permanently.',
        responses: { 204: { description: 'gone' } },
      },
    },
    '/items': {
      post: {
        operationId: 'createItem',
        summary: 'Make an item',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ItemInput' } } },
        },
        responses: { 201: { description: 'made' } },
      },
    },
  },
}

export const startRest = async ({ key }: { key: string }) => {
  const app = new Hono()
  app.use('*', async (c, next) => (c.req.header('x-api-key') === key ? next() : c.json({ error: 'no key' }, 401)))
  app.get('/openapi.json', (c) => c.json(SPEC))
  app.get('/v1/items/:id', (c) =>
    c.req.param('id') === 'missing'
      ? c.json({ error: 'not found' }, 404)
      : c.json({ id: c.req.param('id'), verbose: c.req.query('verbose') ?? null, limit: c.req.query('limit') ?? null }),
  )
  app.delete('/v1/items/:id', (c) => c.body(null, 204))
  app.post('/v1/items', async (c) => c.json({ made: await c.req.json() }, 201))
  app.post('/v1/flags/beta', async (c) => c.json({ flag: await c.req.json() }))
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}
