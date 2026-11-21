import { createFileRoute } from '@tanstack/react-router'
import { PackPage, parsePackTab } from '@/packs/PackPage'

const Pack = () => {
  const { tab, add } = Route.useSearch()
  return <PackPage name={Route.useParams().name} tab={tab} add={add} />
}

export const Route = createFileRoute('/packs/$name')({ validateSearch: parsePackTab, component: Pack })
