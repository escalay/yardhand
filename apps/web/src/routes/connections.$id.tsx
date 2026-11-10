import { createFileRoute } from '@tanstack/react-router'
import { ConnectionPage } from '@/connections/ConnectionPage'
import { parseConnectionTab } from '@/connections/connections.rules'

const Connection = () => <ConnectionPage id={Route.useParams().id} tab={Route.useSearch().tab} />

export const Route = createFileRoute('/connections/$id')({
  validateSearch: (raw: Record<string, unknown>) => parseConnectionTab(raw),
  component: Connection,
})
