import { createFileRoute } from '@tanstack/react-router'
import { PackPage } from '@/packs/PackPage'
import { parsePackTab } from '@/packs/packs.rules'

const Pack = () => {
  const { tab, add, share, build } = Route.useSearch()
  return <PackPage name={Route.useParams().name} tab={tab} add={add} share={share} build={build} />
}

export const Route = createFileRoute('/packs/$name')({ validateSearch: parsePackTab, component: Pack })
