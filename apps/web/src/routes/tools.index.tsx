import { createFileRoute } from '@tanstack/react-router'
import { ToolsPage } from '@/tools/ToolsPage'
import { parseToolsSearch } from '@/tools/tools.rules'

const Tools = () => <ToolsPage search={Route.useSearch()} />

export const Route = createFileRoute('/tools/')({ validateSearch: parseToolsSearch, component: Tools })
