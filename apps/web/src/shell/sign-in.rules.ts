/** Where signing in leads back to: an app's approval on this gateway that sent the owner to sign in, else nowhere. */
export const nextAfterSignIn = (search: string, origin: string) => {
  const next = new URLSearchParams(search).get('next')
  if (!next || !URL.canParse(next, origin)) return null
  const url = new URL(next, origin)
  return url.origin === origin && url.pathname === '/oauth/authorize' && url.search ? url.pathname + url.search : null
}

/** The approval to go back to, read only on the sign-in page itself (`/app/sign-in?next=…`). */
export const approvalWaitingAt = ({
  pathname,
  search,
  origin,
}: {
  pathname: string
  search: string
  origin: string
}) => (pathname === '/app/sign-in' ? nextAfterSignIn(search, origin) : null)
