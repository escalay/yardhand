import { createFileRoute } from '@tanstack/react-router'
import { HomePage } from '@/home/HomePage'
import { parseOverviewSearch } from '@/home/home.rules'

const Home = () => <HomePage search={Route.useSearch()} />

export const Route = createFileRoute('/')({ validateSearch: parseOverviewSearch, component: Home })
