/**
 * Packs: the board, one pack, the people it is shared with, what a playbook uses, what to recheck in the packs, a
 * pack as its keys get it (where it is reached, what a search of it finds, how many tools it lists), and what is
 * written for it: a playbook of its own or its skill with its text and versions, and a check of a draft.
 */
import { queryOptions } from '@tanstack/react-query'
import { api, type Schemas, unwrap } from '@/api/client'

export const packsQuery = queryOptions({ queryKey: ['packs'], queryFn: () => unwrap(api.GET('/api/packs')) })

export const packQuery = (name: string) =>
  queryOptions({
    queryKey: ['pack', name],
    queryFn: () => unwrap(api.GET('/api/packs/{name}', { params: { path: { name } } })),
  })

export const packPeopleQuery = (name: string) =>
  queryOptions({
    queryKey: ['people', name],
    queryFn: () => unwrap(api.GET('/api/packs/{name}/people', { params: { path: { name } } })),
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

/** How many tools a try returns at most: what `search_tools` returns when an agent names no limit. */
export const TRY_LIMIT = 20

/** A search of the pack as its keys are searched (`as`: as that key of it). Never logged. */
export const packTryQuery = (name: string, as: string | undefined, q: string) =>
  queryOptions({
    queryKey: ['pack', name, 'try', { as, q }],
    queryFn: () => unwrap(api.GET('/api/tools', { params: { query: { pack: name, as, q, limit: TRY_LIMIT } } })),
  })

const LISTED_LIMIT = 200

/** How many tools the same viewer is listed without a query, or null when the pack holds more than one answer does. */
export const packListedQuery = (name: string, as: string | undefined) =>
  queryOptions({
    queryKey: ['pack', name, 'listed', { as }],
    queryFn: () => unwrap(api.GET('/api/tools', { params: { query: { pack: name, as, limit: LISTED_LIMIT } } })),
    select: (list) => (list.count < LISTED_LIMIT ? list.count : null),
  })

/** One of a pack's own playbooks with its text and versions: the served text, or an older version's. */
export const packPlaybookQuery = (pack: string, playbook: string, version?: string) =>
  queryOptions({
    queryKey: ['pack', pack, 'playbook', playbook, version ?? 'served'],
    queryFn: () =>
      unwrap(
        api.GET('/api/packs/{name}/playbooks/{playbook}', {
          params: { path: { name: pack, playbook }, query: { version } },
        }),
      ),
  })

/** A pack's skill with its text and versions: the served text, or an older version's. */
export const packSkillQuery = (pack: string, version?: string) =>
  queryOptions({
    queryKey: ['pack', pack, 'skill', version ?? 'served'],
    queryFn: () => unwrap(api.GET('/api/packs/{name}/skill', { params: { path: { name: pack }, query: { version } } })),
  })

/** What a save of this draft would say, with nothing saved. Kept only while the draft is the one on screen. */
export const packCheckQuery = (pack: string, draft: Schemas['PackCheckInput']) =>
  queryOptions({
    queryKey: ['pack', pack, 'check', draft],
    queryFn: () => unwrap(api.POST('/api/packs/{name}/checks', { params: { path: { name: pack } }, body: draft })),
    staleTime: 0,
    gcTime: 0,
  })
