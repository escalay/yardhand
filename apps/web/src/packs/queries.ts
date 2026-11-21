/**
 * Packs: the board, one pack, what a playbook uses, the pack tools to recheck, and a pack as its keys get it: where it
 * is reached, what a search of it finds, and how many tools it lists.
 */
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

export const packSetupQuery = (name: string) =>
  queryOptions({
    queryKey: ['pack', name, 'setup'],
    queryFn: () => unwrap(api.GET('/api/packs/{name}/setup', { params: { path: { name } } })),
    staleTime: Number.POSITIVE_INFINITY,
  })

/** A search of the pack as its keys are searched (`as`: as that key of it). Never logged. */
export const packTryQuery = (name: string, as: string | undefined, q: string) =>
  queryOptions({
    queryKey: ['pack', name, 'try', { as, q }],
    queryFn: () => unwrap(api.GET('/api/tools', { params: { query: { pack: name, as, q } } })),
  })

const LISTED_LIMIT = 200

/** How many tools the same viewer is listed without a query, or null when the pack holds more than one answer does. */
export const packListedQuery = (name: string, as: string | undefined) =>
  queryOptions({
    queryKey: ['pack', name, 'listed', { as }],
    queryFn: () => unwrap(api.GET('/api/tools', { params: { query: { pack: name, as, limit: LISTED_LIMIT } } })),
    select: (list) => (list.count < LISTED_LIMIT ? list.count : null),
  })
