/** What happens inside the gateway, as it happens: the app's live views and "waiting for the first call" listen here. */

export type GatewayEvent =
  | {
      type: 'call'
      data: {
        id: string
        client: string
        clientId: string
        tool: string
        kind: string
        upstream: string | null
        via: string
        status: string
        durationMs: number
        createdAt: string
      }
    }
  | {
      type: 'sync'
      data: {
        upstream: string
        added: string[]
        changed: string[]
        pending: string[]
        removed: string[]
        catalog: { added: string[]; changed: string[]; pending: string[]; removed: string[] }
      }
    }
  | { type: 'upstream'; data: { upstream: string; status: string; lastError: string | null } }
  /** A running call's progress, as its upstream reports it. */
  | {
      type: 'progress'
      data: { client: string; clientId: string; tool: string; progress: number; total?: number; message?: string }
    }
  /** What agents see may have changed: their tools, their playbooks (prompts), their manuals and links (resources). */
  | { type: 'lists'; data: { tools: boolean; prompts: boolean; resources: boolean } }

type Listener = (event: GatewayEvent) => void

export const createEvents = () => {
  const listeners = new Set<Listener>()
  return {
    emit: (event: GatewayEvent) => {
      // A slow or broken listener never holds up a call
      for (const listener of listeners)
        try {
          listener(event)
        } catch {}
    },
    /** Listens until the returned function is called. */
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    get listeners() {
      return listeners.size
    },
  }
}

export type Events = ReturnType<typeof createEvents>
