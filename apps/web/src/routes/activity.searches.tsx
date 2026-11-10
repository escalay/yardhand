import { createFileRoute } from '@tanstack/react-router'
import { parseSearchesSearch, SearchesPage } from '@/activity/SearchesPage'

const Searches = () => <SearchesPage search={Route.useSearch()} />

export const Route = createFileRoute('/activity/searches')({ validateSearch: parseSearchesSearch, component: Searches })
