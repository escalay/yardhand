import { createFileRoute } from '@tanstack/react-router'
import { NewConnection } from '@/connections/NewConnection'

const New = () => <NewConnection fromSetup={Route.useSearch().from === 'setup'} />

export const Route = createFileRoute('/connections/new')({
  validateSearch: (search: Record<string, unknown>): { from?: 'setup' } =>
    search.from === 'setup' ? { from: 'setup' } : {},
  component: New,
})
