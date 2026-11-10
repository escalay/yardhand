/** Search routes: what agents looked for and found nothing they used (owner only). */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'

export const PATH = '/api/searches/unanswered'
export const TAG = 'Searches'
export const LOG_PATH = '/api/searches'

export const UnansweredSchema = z
  .object({
    query: z.string().openapi({ description: 'What was asked, as first typed.', example: 'send gmail' }),
    count: z.number().int().openapi({ description: 'How often it was asked without a tool being called after.' }),
    clients: z.array(z.string()).openapi({ description: 'Which clients asked.' }),
    lastAt: z.string(),
    results: z.number().int().openapi({ description: 'How many tools the latest search found.' }),
  })
  .openapi('UnansweredSearch', { description: 'A search no tool call followed: something agents wanted.' })
const UnansweredListSchema = z
  .object({
    count: z.number().int(),
    days: z.number().int(),
    _links: LinksSchema,
    _embedded: z.object({ searches: z.array(UnansweredSchema) }),
  })
  .openapi('UnansweredSearchList', { description: 'Unanswered searches, most asked first.' })

const SearchEntrySchema = z
  .object({
    id: z.string(),
    query: z.string(),
    clientId: z.string(),
    client: z.string(),
    via: z.string(),
    results: z.number().int(),
    tools: z.array(z.string()).openapi({ description: 'The first tools it found, best first.' }),
    followedBy: z
      .string()
      .nullable()
      .openapi({ description: 'The tool it called next among those it found (within ten minutes), or null.' }),
    at: z.string(),
  })
  .openapi('SearchEntry', { description: 'One tool search by an agent, and what came of it.' })
const SearchLogSchema = z
  .object({
    count: z.number().int(),
    days: z.number().int(),
    _links: LinksSchema,
    _embedded: z.object({ searches: z.array(SearchEntrySchema) }),
  })
  .openapi('SearchLog', { description: 'Agents’ tool searches, newest first.' })

export const routes = {
  log: createRoute({
    method: 'get',
    path: LOG_PATH,
    operationId: 'listSearches',
    tags: [TAG],
    summary: 'Searches',
    description:
      'Every tool search agents made, newest first, with what they found and the tool they called next (owner only).',
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(90).default(7).openapi({ description: 'How far back (1–90 days).' }),
        client: z.string().max(40).optional().openapi({ description: 'Only this agent’s searches.' }),
        pack: z.string().max(40).optional().openapi({ description: 'Only searches by keys locked to this pack.' }),
        unanswered: z
          .enum(['true', 'false'])
          .optional()
          .openapi({ description: '`true`: only searches nothing came of.' }),
        limit: z.coerce.number().int().min(1).max(500).default(100).openapi({ description: 'At most this many.' }),
      }),
    },
    responses: {
      200: { content: { [HAL_JSON]: { schema: SearchLogSchema } }, description: 'The searches.' },
      ...problemResponses(400, 401, 403, 404),
    },
  }),
  unanswered: createRoute({
    method: 'get',
    path: PATH,
    operationId: 'listUnansweredSearches',
    tags: [TAG],
    summary: 'What agents looked for',
    description:
      'Tool searches no call followed within ten minutes, grouped by what was asked, most asked first (owner only). A strong hint at what to connect next.',
    request: {
      query: z.object({
        days: z.coerce.number().int().min(1).max(90).default(7).openapi({ description: 'How far back (1–90 days).' }),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .openapi({ description: 'At most this many (1–100).' }),
      }),
    },
    responses: {
      200: { content: { [HAL_JSON]: { schema: UnansweredListSchema } }, description: 'Unanswered searches.' },
      ...problemResponses(400, 401, 403),
    },
  }),
}
