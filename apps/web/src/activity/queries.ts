/** The call log: pages by cursor, one call, and what it sent and got back. */
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { api, nextCursor, unwrap } from '@/api/client'
import { type ActivitySearch, callsQueryOf } from './activity.rules'

export const callsQuery = (search: Omit<ActivitySearch, 'call'>, limit = 50) =>
  infiniteQueryOptions({
    queryKey: ['calls', search, limit],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/calls', {
          params: {
            query: { limit, cursor: pageParam, ...callsQueryOf(search) },
          },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => nextCursor(page as never),
  })

export const callQuery = (id: string) =>
  queryOptions({
    queryKey: ['call', id],
    queryFn: () => unwrap(api.GET('/api/calls/{id}', { params: { path: { id } } })),
  })

export const payloadQuery = (id: string) =>
  queryOptions({
    queryKey: ['payload', id],
    queryFn: () => unwrap(api.GET('/api/calls/{id}/payload', { params: { path: { id } } })),
    retry: false,
  })

export const searchesQuery = (query: { days: number; client?: string; pack?: string; unanswered?: 'true' }) =>
  queryOptions({
    queryKey: ['searches', query],
    queryFn: () => unwrap(api.GET('/api/searches', { params: { query: { ...query, limit: 200 } } })),
  })
