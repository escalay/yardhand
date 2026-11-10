/** Pinning a tool for every agent without its own pins (the global pins, at most 40). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, unwrap } from '@/api/client'
import { pinsQuery } from './queries'

export const usePins = () => {
  const queries = useQueryClient()
  const pins = useQuery(pinsQuery)
  const save = useMutation({
    mutationFn: (tools: string[]) => unwrap(api.PUT('/api/pins', { body: { tools } })),
    onSuccess: () => {
      for (const key of [['pins'], ['tools'], ['overview']]) void queries.invalidateQueries({ queryKey: key })
    },
    onError: (error) => toast.error(error.message),
  })
  const list = pins.data?.tools ?? []
  const toggle = (name: string) => {
    if (list.includes(name)) save.mutate(list.filter((pinned) => pinned !== name))
    else if (list.length >= 40)
      toast.error('40 pins at most: unpin one first. Agents still find the rest by searching.')
    else save.mutate([...list, name])
  }
  return { pinned: (name: string) => list.includes(name), toggle, busy: save.isPending }
}
