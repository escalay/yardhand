/** Tools: the list (searched by words and meaning when there's a query), one tool, and the global pins. */
import { queryOptions } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'

export const toolsQuery = ({ q, upstream, as }: { q?: string; upstream?: string; as?: string }) =>
  queryOptions({
    queryKey: ['tools', { q, upstream, as }],
    queryFn: () => unwrap(api.GET('/api/tools', { params: { query: { q, upstream, as, limit: q ? 60 : 5000 } } })),
    placeholderData: (previous) => previous,
  })

export const toolQuery = (name: string) =>
  queryOptions({
    queryKey: ['tool', name],
    queryFn: () => unwrap(api.GET('/api/tools/{name}', { params: { path: { name }, query: { view: 'full' } } })),
  })

export const pinsQuery = queryOptions({ queryKey: ['pins'], queryFn: () => unwrap(api.GET('/api/pins')) })
