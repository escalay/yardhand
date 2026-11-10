import { createFileRoute } from '@tanstack/react-router'
import { NewAgent } from '@/agents/NewAgent'

const New = () => <NewAgent pack={Route.useSearch().pack} />

export const Route = createFileRoute('/agents/new')({
  validateSearch: (raw: Record<string, unknown>): { pack?: string } =>
    typeof raw.pack === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(raw.pack) ? { pack: raw.pack } : {},
  component: New,
})
