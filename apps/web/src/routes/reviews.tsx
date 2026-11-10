import { createFileRoute, redirect } from '@tanstack/react-router'

/** Reviews moved under Tools; old links and alerts still land there. */
export const Route = createFileRoute('/reviews')({
  beforeLoad: () => {
    throw redirect({ to: '/tools/reviews', replace: true })
  },
})
