/** Who is signed in, and the counts the sidebar shows. */
import { queryOptions } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'

export const meQuery = queryOptions({ queryKey: ['me'], queryFn: () => unwrap(api.GET('/api/me')), staleTime: 60_000 })
export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: () => unwrap(api.GET('/api/session')),
})
export const overviewQuery = queryOptions({
  queryKey: ['overview'],
  queryFn: () => unwrap(api.GET('/api/overview')),
  staleTime: 15_000,
})
export const systemQuery = queryOptions({ queryKey: ['system'], queryFn: () => unwrap(api.GET('/api/system')) })
export const telemetryQuery = queryOptions({
  queryKey: ['telemetry'],
  queryFn: () => unwrap(api.GET('/api/system/telemetry')),
  staleTime: 60_000,
})
export const updatesQuery = queryOptions({
  queryKey: ['updates'],
  queryFn: () => unwrap(api.GET('/api/system/updates')),
  staleTime: 60_000,
})
