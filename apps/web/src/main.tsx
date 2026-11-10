import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiError } from './api/client'
import { routeTree } from './routeTree.gen'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // A refusal (4xx) won't change on a retry; a hiccup (5xx, network) might
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
})

/**
 * A deploy renames the app's files, so a tab opened before it can ask for a file that is gone: load the new app once
 * instead of showing an error (at most once a minute, so a real outage doesn't loop).
 */
const reloadForNewVersion = () => {
  try {
    const last = Number(sessionStorage.getItem('gw.reloadedAt') ?? 0)
    if (Date.now() - last < 60_000) return false
    sessionStorage.setItem('gw.reloadedAt', String(Date.now()))
  } catch {}
  location.reload()
  return true
}
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForNewVersion()) event.preventDefault()
})
const STALE_FILE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/

const router = createRouter({
  routeTree,
  basepath: '/app',
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  defaultOnCatch: (error) => {
    if (error instanceof Error && STALE_FILE.test(error.message)) reloadForNewVersion()
  },
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const root = document.getElementById('app')
if (root)
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  )
