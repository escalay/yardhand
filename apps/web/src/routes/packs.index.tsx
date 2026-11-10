import { createFileRoute } from '@tanstack/react-router'
import { PacksPage } from '@/packs/PacksPage'

export const Route = createFileRoute('/packs/')({ component: PacksPage })
