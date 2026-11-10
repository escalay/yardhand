import { createFileRoute } from '@tanstack/react-router'
import { ActivityPage } from '@/activity/ActivityPage'
import { parseActivitySearch } from '@/activity/activity.rules'

const Activity = () => <ActivityPage search={Route.useSearch()} />

export const Route = createFileRoute('/activity/')({
  validateSearch: parseActivitySearch,
  component: Activity,
})
