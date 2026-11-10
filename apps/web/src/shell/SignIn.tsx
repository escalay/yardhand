/**
 * Signing in where Cloudflare Access isn't in front (the single compose deploy, local dev): an owner key, traded once
 * for a session cookie. Behind Access the edge signs the owner in before this page could show.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, unwrap } from '@/api/client'
import { Claim } from '@/setup/Claim'
import { Wordmark } from '@/setup/Wordmark'
import { Backdrop } from '@/ui/Backdrop'
import { Field } from '@/ui/Field'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'
import { sessionQuery } from './queries'

export const SignIn = () => {
  const queries = useQueryClient()
  const session = useQuery(sessionQuery)
  const [key, setKey] = useState('')
  const signIn = useMutation({
    mutationFn: () => unwrap(api.POST('/api/session', { body: { key: key.trim() } })),
    onSuccess: () => queries.invalidateQueries(),
  })
  const byKey = session.data?.methods.includes('key') ?? true
  const byAccess = session.data?.methods.includes('access') ?? false

  // A new instance nobody owns yet: claim it with the code from the server's log
  if (session.data?.setup) return <Claim />
  return (
    <main className="grid min-h-svh lg:grid-cols-2">
      <section className="relative hidden overflow-hidden bg-inverse lg:block">
        <Backdrop />
        <div className="relative flex h-full flex-col gap-16 p-12">
          <Wordmark inverse />
          <p className="mt-[12vh] max-w-md text-4xl tracking-tight text-balance text-inverse-foreground">
            Connect a server once. <em className="font-semibold italic">Every agent</em> can use it.
          </p>
        </div>
      </section>
      <section className="flex flex-col items-center justify-center gap-8 px-6 py-16">
        <Wordmark className="lg:hidden" />
        <div className="flex w-full max-w-sm flex-col gap-2 text-center">
          <h1 className="text-3xl tracking-tight">
            Sign in to <em>Yardhand</em>
          </h1>
          <p className="text-sm text-pretty text-muted-foreground">
            Only the owner signs in here. Agents never do: they use the keys you give them.
          </p>
        </div>
        {byKey ? (
          <form
            className="flex w-full max-w-sm flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              signIn.mutate()
            }}
          >
            <Field
              label="Owner key"
              hint="It starts gw_owner_ and was shown once, when this instance was set up. The browser keeps a session, never the key."
              error={signIn.error?.message ?? null}
            >
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder="gw_…"
                />
              )}
            </Field>
            <Button type="submit" variant="primary" disabled={!key.trim() || signIn.isPending}>
              {signIn.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        ) : null}
        {byAccess ? (
          <Button variant="muted" onClick={() => location.assign('/app')}>
            Sign in with Cloudflare Access
          </Button>
        ) : null}
      </section>
    </main>
  )
}
