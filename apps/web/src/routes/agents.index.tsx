import { createFileRoute } from '@tanstack/react-router'
import { AgentsPage } from '@/agents/AgentsPage'

export const Route = createFileRoute('/agents/')({ component: AgentsPage })
