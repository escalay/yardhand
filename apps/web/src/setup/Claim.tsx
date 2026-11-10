/**
 * Claiming a new instance: the setup code from the server's log, then the owner key, shown this once, with a way to
 * copy it and a promise to keep it before going on to the setup.
 */
import { IconCheck } from '@tabler/icons-react'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { api, unwrap } from '@/api/client'
import { Backdrop } from '@/ui/Backdrop'
import { Mono } from '@/ui/Code'
import { CopyButton } from '@/ui/Copy'
import { Field } from '@/ui/Field'
import { Button } from '@/ui/shadcn/button'
import { Checkbox } from '@/ui/shadcn/checkbox'
import { Input } from '@/ui/shadcn/input'
import { Wordmark } from './Wordmark'

/** The same two halves as sign-in: the yard backdrop with the promise on the left, the one task on the right. */
const Frame = ({ children }: { children: React.ReactNode }) => (
  <main className="grid min-h-svh lg:grid-cols-2">
    <section className="relative hidden overflow-hidden bg-inverse lg:block">
      <Backdrop />
      <div className="relative flex h-full flex-col gap-16 p-12">
        <Wordmark inverse />
        <div className="mt-[12vh] flex max-w-md flex-col gap-8">
          <p className="text-4xl tracking-tight text-balance text-inverse-foreground">
            Connect a server once. <em className="font-semibold italic">Every agent</em> can use it.
          </p>
          <ul className="flex flex-col gap-3 text-inverse-foreground/80">
            {PROMISES.map((line) => (
              <li key={line} className="flex items-center gap-3">
                <IconCheck className="size-4 text-inverse-foreground" /> {line}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
    <section className="flex flex-col items-center justify-center gap-8 px-6 py-16">
      <Wordmark className="lg:hidden" />
      <div className="flex w-full max-w-sm flex-col gap-8">{children}</div>
    </section>
  </main>
)

const PROMISES = ['Your keys stay on this machine', 'Every call is on the record', 'Agents see only what you allow']

const Saved = ({ ownerKey }: { ownerKey: string }) => {
  const [kept, setKept] = useState(false)
  return (
    <Frame>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl tracking-tight text-balance">
          This is your <em>owner key</em>
        </h1>
        <p className="text-sm text-pretty text-muted-foreground">
          Copy it now and keep it in your password manager: you won’t see it again. It signs you in here, and scripts
          send it as a Bearer key.
        </p>
      </div>
      <div className="flex flex-col gap-3 border border-border bg-card p-5">
        <Mono className="text-[13px] break-all select-all">{ownerKey}</Mono>
        <CopyButton text={ownerKey} label="Copy the key" variant="primary" />
      </div>
      <label className="flex items-start gap-3 text-sm">
        <Checkbox checked={kept} onCheckedChange={(on) => setKept(on === true)} className="mt-0.5" />
        <span>I saved it in my password manager</span>
      </label>
      <Button variant="primary" disabled={!kept} onClick={() => location.assign('/app/setup')}>
        Set up Yardhand
      </Button>
      <p className="text-xs text-pretty text-muted-foreground">
        Lost it later? <Mono className="text-xs">scripts/reset-owner.ts</Mono> forgets the owner and the next start asks
        for a new setup code. The README shows how.
      </p>
    </Frame>
  )
}

export const Claim = () => {
  const [code, setCode] = useState('')
  const claim = useMutation({
    mutationFn: () => unwrap(api.POST('/api/session/claim', { body: { code: code.trim() } })),
  })
  if (claim.data) return <Saved ownerKey={claim.data.key} />
  return (
    <Frame>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl tracking-tight text-balance">
          Welcome to <em>Yardhand</em>
        </h1>
        <p className="text-sm text-pretty text-muted-foreground">
          Enter the setup code from the server’s log to make this instance yours. From then on, every tool your agents
          use is behind one address.
        </p>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          claim.mutate()
        }}
      >
        <Field
          label="Setup code"
          hint={
            <>
              In the server’s log: <Mono className="text-xs">docker compose logs gateway</Mono>. It works once, and a
              restart makes a new one.
            </>
          }
          error={claim.error?.message ?? null}
        >
          {(id) => (
            <Input
              id={id}
              autoFocus
              autoComplete="one-time-code"
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="7F3K-92QD"
              className="h-12 font-mono text-lg tracking-[0.2em]"
            />
          )}
        </Field>
        <Button
          type="submit"
          variant="primary"
          disabled={code.replace(/[^0-9A-Z]/gi, '').length < 8 || claim.isPending}
        >
          {claim.isPending ? 'Checking…' : 'Claim this instance'}
        </Button>
      </form>
    </Frame>
  )
}
