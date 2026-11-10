import { createFileRoute } from '@tanstack/react-router'
import { AgentPage } from '@/agents/AgentPage'

const Agent = () => <AgentPage id={Route.useParams().id} tab={Route.useSearch().tab} />

export const Route = createFileRoute('/agents/$id')({
  validateSearch: (raw: Record<string, unknown>): { tab?: 'activity' } =>
    raw.tab === 'activity' ? { tab: 'activity' } : {},
  component: Agent,
})
