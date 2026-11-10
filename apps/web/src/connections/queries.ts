/** Connections (the API calls them upstreams): the list, one, and its tools. */
import { queryOptions } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'

export const upstreamsQuery = queryOptions({
  queryKey: ['upstreams'],
  queryFn: () => unwrap(api.GET('/api/upstreams')),
})

export const upstreamQuery = (id: string) =>
  queryOptions({
    queryKey: ['upstream', id],
    queryFn: () => unwrap(api.GET('/api/upstreams/{id}', { params: { path: { id } } })),
  })

export const upstreamToolsQuery = (id: string) =>
  queryOptions({
    queryKey: ['tools', { upstream: id }],
    queryFn: () => unwrap(api.GET('/api/tools', { params: { query: { upstream: id, limit: 5000 } } })),
  })

/** What a connection offers besides tools: its manuals, playbooks and links. */
export const manualsQuery = (upstream: string) =>
  queryOptions({
    queryKey: ['catalog', 'manuals', upstream],
    queryFn: () => unwrap(api.GET('/api/manuals', { params: { query: { upstream } } })),
  })

/** A manual in full; each fetch is logged as a read, so it is kept a while. */
export const manualQuery = (name: string) =>
  queryOptions({
    queryKey: ['catalog', 'manual', name],
    queryFn: () => unwrap(api.GET('/api/manuals/{name}', { params: { path: { name } } })),
    staleTime: 10 * 60_000,
  })

export const playbooksQuery = (upstream: string) =>
  queryOptions({
    queryKey: ['catalog', 'playbooks', upstream],
    queryFn: () => unwrap(api.GET('/api/playbooks', { params: { query: { upstream } } })),
  })

export const linksQuery = (upstream: string) =>
  queryOptions({
    queryKey: ['catalog', 'links', upstream],
    queryFn: () => unwrap(api.GET('/api/links', { params: { query: { upstream } } })),
  })
