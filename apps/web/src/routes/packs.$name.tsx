import { createFileRoute } from '@tanstack/react-router'
import { PackPage, parsePackTab } from '@/packs/PackPage'

const Pack = () => <PackPage name={Route.useParams().name} tab={Route.useSearch().tab} />

export const Route = createFileRoute('/packs/$name')({ validateSearch: parsePackTab, component: Pack })
