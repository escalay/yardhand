/** Packs: the board, one pack, what a playbook uses, and the pack tools to recheck. */
import { queryOptions } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'

export const packsQuery = queryOptions({ queryKey: ['packs'], queryFn: () => unwrap(api.GET('/api/packs')) })

export const packQuery = (name: string) =>
  queryOptions({
    queryKey: ['pack', name],
    queryFn: () => unwrap(api.GET('/api/packs/{name}', { params: { path: { name } } })),
  })

export const usesQuery = (playbook: string, pack?: string) =>
  queryOptions({
    queryKey: ['uses', playbook, pack],
    queryFn: () =>
      unwrap(api.GET('/api/playbooks/{name}/uses', { params: { path: { name: playbook }, query: { pack } } })),
    staleTime: 60_000,
  })

export const flagsQuery = queryOptions({
  queryKey: ['packs', 'flags'],
  queryFn: () => unwrap(api.GET('/api/packs/flags')),
})

export const allPlaybooksQuery = queryOptions({
  queryKey: ['catalog', 'playbooks', 'all'],
  queryFn: () => unwrap(api.GET('/api/playbooks', { params: { query: { limit: 200 } } })),
})
