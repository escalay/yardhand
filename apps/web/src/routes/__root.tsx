/** Every page: signed in as the owner (else the sign-in page), inside the shell, following live events. */
import type { QueryClient } from '@tanstack/react-query'
import { useQuery } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet, useRouterState } from '@tanstack/react-router'
import { ApiError } from '@/api/client'
import { AppShell } from '@/shell/AppShell'
import { LiveProvider } from '@/shell/live'
import { meQuery } from '@/shell/queries'
import { SignIn } from '@/shell/SignIn'
import { Empty } from '@/ui/Empty'
import { Page } from '@/ui/Page'
import { Button } from '@/ui/shadcn/button'
import { Toaster } from '@/ui/shadcn/sonner'
import { TooltipProvider } from '@/ui/shadcn/tooltip'

const Root = () => {
  const me = useQuery({ ...meQuery, retry: false })
  // The guided setup is a page of its own, without the tabs
  const bare = useRouterState({ select: (state) => state.location.pathname.startsWith('/setup') })
  if (me.isPending) return <div className="min-h-svh" aria-busy="true" />
  if (me.error instanceof ApiError && (me.error.status === 401 || me.error.status === 403)) return <SignIn />
  if (me.error)
    return (
      <Page>
        <Empty
          illustration="storm"
          title="Yardhand didn't answer"
          action={<Button onClick={() => me.refetch()}>Try again</Button>}
        >
          {me.error.message}. If it keeps happening, the server may be restarting: give it a minute.
        </Empty>
      </Page>
    )
  if (!me.data.owner)
    return (
      <Page>
        <Empty illustration="sign-in" title="This key can't manage Yardhand">
          It is a client key: it reaches tools, not settings. Sign in with an owner key.
        </Empty>
      </Page>
    )
  return (
    <TooltipProvider delayDuration={300}>
      <LiveProvider>
        {bare ? (
          <Outlet />
        ) : (
          <AppShell>
            <Outlet />
          </AppShell>
        )}
      </LiveProvider>
      <Toaster />
    </TooltipProvider>
  )
}

const NotFound = () => (
  <Page>
    <Empty
      illustration="not-found"
      title="Nothing lives at this address"
      action={
        <Button asChild>
          <Link to="/">Back to Home</Link>
        </Button>
      }
    >
      It may have been removed, or the link was cut short. ⌘K finds anything by name.
    </Empty>
  </Page>
)

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
  notFoundComponent: NotFound,
})
