import { createFileRoute } from '@tanstack/react-router'
import { ToolPage } from '@/tools/ToolPage'

const Tool = () => {
  const { args, tab } = Route.useSearch()
  return <ToolPage name={Route.useParams().name} args={args} tab={tab} />
}

export const Route = createFileRoute('/tools/$name')({
  validateSearch: (raw: Record<string, unknown>): { args?: string; tab?: 'activity' } => ({
    ...(typeof raw.args === 'string' ? { args: raw.args } : {}),
    ...(raw.tab === 'activity' ? { tab: 'activity' as const } : {}),
  }),
  component: Tool,
})
