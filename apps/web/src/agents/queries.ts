/** Agents (the API calls them clients): the list, one, and its setup snippets. */
import { queryOptions } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'

export const clientsQuery = queryOptions({ queryKey: ['clients'], queryFn: () => unwrap(api.GET('/api/clients')) })

export const clientQuery = (id: string) =>
  queryOptions({
    queryKey: ['client', id],
    queryFn: () => unwrap(api.GET('/api/clients/{id}', { params: { path: { id } } })),
  })

export const setupQuery = (id: string) =>
  queryOptions({
    queryKey: ['setup', id],
    queryFn: () => unwrap(api.GET('/api/clients/{id}/setup', { params: { path: { id } } })),
    staleTime: Number.POSITIVE_INFINITY,
  })
