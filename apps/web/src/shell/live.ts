/**
 * The gateway's live events (`GET /api/events`) for the whole app: each event marks the queries it changes as stale,
 * so every screen follows what happens without polling. Screens can also listen to one kind (the first call of a new
 * key). Reconnects on its own; `useLive().connected` drives the Live dot.
 */
import { useQueryClient } from '@tanstack/react-query'
import { createContext, createElement, useContext, useEffect, useRef, useState } from 'react'

export type CallEvent = {
  id: string
  client: string
  clientId: string
  tool: string
  upstream: string | null
  via: 'rest' | 'mcp' | 'passthrough' | 'app'
  status: 'ok' | 'tool_error' | 'refused' | 'failed' | 'asked'
  kind?: string
  durationMs: number
  createdAt: string
}
type Listener = (event: { type: string; data: unknown }) => void

const LiveContext = createContext<{ connected: boolean; listen: (listener: Listener) => () => void }>({
  connected: false,
  listen: () => () => {},
})

/** Which cached queries each kind of event makes stale. */
export const STALE_BY_EVENT: Record<string, string[][]> = {
  call: [['calls'], ['overview'], ['clients'], ['client'], ['tools']],
  sync: [['upstreams'], ['upstream'], ['tools'], ['tool'], ['reviews'], ['overview'], ['packs'], ['pack']],
  upstream: [['upstreams'], ['upstream'], ['overview']],
  lists: [['upstreams'], ['upstream'], ['tools'], ['catalog'], ['me'], ['packs'], ['pack']],
  progress: [],
}

export type ProgressEvent = {
  client: string
  clientId: string
  tool: string
  progress: number
  total?: number
  message?: string
}

export const LiveProvider = ({ children }: { children: React.ReactNode }) => {
  const queries = useQueryClient()
  const [connected, setConnected] = useState(false)
  const listeners = useRef(new Set<Listener>())
  useEffect(() => {
    const source = new EventSource('/api/events')
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    const on = (type: string) => (message: MessageEvent<string>) => {
      const data = JSON.parse(message.data) as unknown
      for (const key of STALE_BY_EVENT[type] ?? []) void queries.invalidateQueries({ queryKey: key })
      for (const listener of listeners.current) listener({ type, data })
    }
    const handlers = Object.keys(STALE_BY_EVENT).map((type) => [type, on(type)] as const)
    for (const [type, handler] of handlers) source.addEventListener(type, handler as EventListener)
    return () => source.close()
  }, [queries])
  const listen = (listener: Listener) => {
    listeners.current.add(listener)
    return () => void listeners.current.delete(listener)
  }
  return createElement(LiveContext.Provider, { value: { connected, listen } }, children)
}

export const useLive = () => useContext(LiveContext)

/** Calls as they land, newest first, kept while the screen is open. */
export const useLiveCalls = (filter: (call: CallEvent) => boolean = () => true) => {
  const { listen } = useLive()
  const [calls, setCalls] = useState<CallEvent[]>([])
  const keep = useRef(filter)
  keep.current = filter
  useEffect(
    () =>
      listen(({ type, data }) => {
        if (type === 'call' && keep.current(data as CallEvent))
          setCalls((seen) => [data as CallEvent, ...seen].slice(0, 50))
      }),
    [listen],
  )
  return calls
}

/** Calls still running that report progress: the latest step of each, gone once the call lands. */
export const useRunning = () => {
  const { listen } = useLive()
  const [running, setRunning] = useState<Record<string, ProgressEvent & { at: number }>>({})
  useEffect(
    () =>
      listen(({ type, data }) => {
        if (type === 'progress') {
          const step = data as ProgressEvent
          setRunning((now) => ({ ...now, [`${step.clientId}:${step.tool}`]: { ...step, at: Date.now() } }))
        }
        if (type === 'call') {
          const call = data as CallEvent
          setRunning((now) => {
            const { [`${call.clientId}:${call.tool}`]: _done, ...rest } = now
            return rest
          })
        }
      }),
    [listen],
  )
  return Object.values(running).sort((a, b) => b.at - a.at)
}
