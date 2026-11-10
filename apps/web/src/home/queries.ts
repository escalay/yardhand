/** Overview's numbers for a window, a door and the top bar's scope. */
import { queryOptions } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'
import type { Door, Range } from '@/shell/filters.rules'

export const statsQuery = (query: { range: Range; via?: Door; pack?: string; client?: string }) =>
  queryOptions({
    queryKey: ['overview', 'stats', query],
    queryFn: () => unwrap(api.GET('/api/overview/stats', { params: { query } })),
    placeholderData: (previous) => previous,
  })
