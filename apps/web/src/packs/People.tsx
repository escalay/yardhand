/**
 * The people a pack is shared with, one row each: how they connect, what they can do, when it ends, their last call
 * and their calls in 7 days, their own values when the pack fills inputs per person, with Extend, Revoke, Values and
 * their Activity. Someone whose access ended stays for 30 days, to be extended. Under them, the addresses the pack
 * used to have that still answer, and stopping one.
 */
import { IconAlertTriangle, IconChevronDown, IconUserPlus } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { api, type Pack, type Person, unwrap } from '@/api/client'
import { Mono } from '@/ui/Code'
import { cn } from '@/ui/cn'
import { Empty } from '@/ui/Empty'
import { ago } from '@/ui/format'
import { Section } from '@/ui/Page'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/ui/shadcn/alert-dialog'
import { Button } from '@/ui/shadcn/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/ui/shadcn/dropdown-menu'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { ValuesDialog } from './PersonValues'
import {
  accessOf,
  alsoOpens,
  connectsVia,
  dayOf,
  EXTEND_CHOICES,
  endsOf,
  type PersonalField,
  personalFields,
  type ShareLifetime,
  stillThere,
  valuesLine,
} from './packs.rules'
import { packPeopleQuery } from './queries'

// The app clears the browser's focus outline: these carry the ring its buttons show
const LINK = 'rounded-xs hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/40'

// A table where the page gives it room (`@4xl`); narrower, each row is a block and each cell a line that says what it is
const ROW =
  'border-b border-border last:border-b-0 @max-4xl:grid @max-4xl:gap-x-10 @max-4xl:gap-y-1.5 @max-4xl:p-4 @xl:@max-4xl:grid-cols-2'
const CELL =
  '@4xl:px-4 @4xl:py-3 @max-4xl:flex @max-4xl:items-baseline @max-4xl:justify-between @max-4xl:gap-4 @max-4xl:before:text-xs @max-4xl:before:text-muted-foreground @max-4xl:before:content-[attr(data-label)]'
const NOTE = 'text-xs font-normal text-pretty text-muted-foreground'

const Row = ({
  pack,
  person,
  fields,
  busy,
  onExtend,
  onRevoke,
}: {
  pack: string
  person: Person
  /** The pack's Per person variables: none, and there is nothing of theirs to set. */
  fields: PersonalField[]
  busy: boolean
  onExtend: (expiresIn: ShareLifetime) => void
  onRevoke: () => void
}) => {
  const ends = endsOf(person)
  const others = alsoOpens(person.otherPacks)
  const [editing, setEditing] = useState(false)
  const values = valuesLine(person.values)
  return (
    <tr className={cn(ROW, person.ended && 'text-muted-foreground')}>
      <td className="@max-4xl:col-span-full @4xl:px-4 @4xl:py-3">
        <span className="flex flex-col items-start gap-0.5">
          <Link to="/agents/$id" params={{ id: person.id }} className={cn(LINK, 'font-medium break-words')}>
            {person.name}
          </Link>
          {person.oldAddress ? (
            <span className="text-xs text-muted-foreground">
              Still connects at <Mono>/p/{person.oldAddress.name}</Mono>, last {ago(person.oldAddress.lastAt)}
            </span>
          ) : null}
          {person.otherPacks.length ? (
            <span className="text-xs text-muted-foreground">Also opens {person.otherPacks.join(', ')}</span>
          ) : null}
          {fields.length ? (
            <span className="text-xs text-muted-foreground">{values || 'The pack’s values'}</span>
          ) : null}
        </span>
        {editing ? (
          <ValuesDialog pack={pack} person={person} fields={fields} open={editing} onOpenChange={setEditing} />
        ) : null}
      </td>
      <td data-label="Connects via" className={CELL}>
        {connectsVia(person)}
      </td>
      <td data-label="Access" className={CELL}>
        {accessOf(person.scope)}
      </td>
      <td data-label="Ends" className={CELL}>
        <span className={cn('inline-flex items-center gap-1', ends.warn && 'text-foreground')}>
          {ends.warn ? <IconAlertTriangle aria-hidden="true" className="size-4 shrink-0 text-warn" /> : null}
          {ends.text}
        </span>
      </td>
      <td data-label="Last call" className={CELL}>
        {ago(person.lastCallAt)}
      </td>
      <td data-label="Calls in 7 days" className={cn(CELL, '@4xl:text-right')}>
        <span className="font-mono text-xs">{person.calls7d}</span>
      </td>
      <td className="@max-4xl:col-span-full @max-4xl:pt-1 @4xl:px-4 @4xl:py-2">
        <span className="flex flex-wrap items-center gap-1 @4xl:flex-nowrap @4xl:justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="muted" disabled={busy} aria-label={`Extend ${person.name}`}>
                Extend <IconChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {person.ended ? <DropdownMenuLabel className={NOTE}>The same key works again.</DropdownMenuLabel> : null}
              {others ? <DropdownMenuLabel className={NOTE}>{others}</DropdownMenuLabel> : null}
              {EXTEND_CHOICES.map((choice) => (
                <DropdownMenuItem key={choice.value} onSelect={() => onExtend(choice.value)}>
                  {choice.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {fields.length ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              aria-label={`${person.name}'s values`}
              onClick={() => setEditing(true)}
            >
              Values
            </Button>
          ) : null}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="xs"
                variant="ghost"
                className="text-error hover:text-error"
                disabled={busy}
                aria-label={`Revoke ${person.name}`}
              >
                Revoke
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Revoke {person.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  {person.name}'s key stops working at once; their app will say the key is not valid.
                  {others ? ` ${others}` : ''} This can't be undone: sharing again makes a new key.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction variant="danger" onClick={onRevoke}>
                  Revoke
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button asChild size="xs" variant="ghost">
            <Link
              to="/activity"
              search={{ outcome: 'all', client: person.id }}
              aria-label={`${person.name}'s activity`}
            >
              Activity
            </Link>
          </Button>
        </span>
      </td>
    </tr>
  )
}

export const People = ({ pack, onShare }: { pack: Pack; onShare: () => void }) => {
  const queries = useQueryClient()
  const people = useQuery(packPeopleQuery(pack.name))
  const refresh = () => {
    // Home too: it names who is about to end
    for (const key of [['people'], ['pack'], ['packs'], ['clients'], ['client'], ['overview']])
      void queries.invalidateQueries({ queryKey: key })
  }
  const extend = useMutation({
    mutationFn: ({ id, expiresIn }: { id: string; expiresIn: ShareLifetime }) =>
      unwrap(api.PATCH('/api/clients/{id}', { params: { path: { id } }, body: { expiresIn } })),
    onSuccess: () => {
      toast.success('Extended. It applies to their next call.')
      refresh()
    },
    onError: (error) => toast.error(error.message),
  })
  const revoke = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/api/clients/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      toast.success('Revoked. Their key stopped working just now.')
      refresh()
    },
    onError: (error) => toast.error(error.message),
  })
  const free = useMutation({
    mutationFn: (former: string) =>
      unwrap(api.DELETE('/api/packs/{name}/names/{former}', { params: { path: { name: pack.name, former } } })),
    onSuccess: (_done, former) => {
      toast.success(`/p/${former} no longer answers. The name is free.`)
      refresh()
    },
    onError: (error) => toast.error(error.message),
  })

  if (people.isPending) return <Skeleton className="h-48 rounded-none" />
  if (people.error)
    return (
      <Empty
        illustration="storm"
        title="People didn't load"
        action={
          <Button variant="muted" onClick={() => void people.refetch()}>
            Try again
          </Button>
        }
      >
        {people.error.message}
      </Empty>
    )

  const rows = people.data._embedded.people
  const fields = personalFields(pack)
  const busy = extend.isPending || revoke.isPending
  return (
    <div className="flex flex-col gap-8">
      {/* Waiting to join goes here, above the people */}
      {rows.length ? (
        <div className="@container border border-border bg-card">
          <table className="w-full text-sm @max-4xl:block">
            <thead className="@max-4xl:sr-only">
              <tr className="border-b border-border text-left text-xs tracking-wide whitespace-nowrap text-muted-foreground uppercase">
                <th className="px-4 py-3 font-normal">Person</th>
                <th className="px-4 py-3 font-normal">Connects via</th>
                <th className="px-4 py-3 font-normal">Access</th>
                <th className="px-4 py-3 font-normal">Ends</th>
                <th className="px-4 py-3 font-normal">Last call</th>
                <th className="px-4 py-3 text-right font-normal">
                  <span aria-hidden="true">7 days</span>
                  <span className="sr-only">Calls in 7 days</span>
                </th>
                <th className="px-4 py-3 font-normal">
                  <span className="sr-only">Extend, values, revoke, activity</span>
                </th>
              </tr>
            </thead>
            <tbody className="@max-4xl:block">
              {rows.map((person) => (
                <Row
                  key={person.id}
                  pack={pack.name}
                  person={person}
                  fields={fields}
                  busy={busy}
                  onExtend={(expiresIn) => extend.mutate({ id: person.id, expiresIn })}
                  onRevoke={() => revoke.mutate(person.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          illustration="agents"
          title="Nobody has access yet"
          action={
            <Button variant="primary" disabled={!pack.tools.length} onClick={onShare}>
              <IconUserPlus /> Share {pack.title}
            </Button>
          }
        >
          {pack.tools.length
            ? `Share makes one person's key for ${pack.title} alone, and a message to send them with the setup in it.`
            : `Add tools first: a key to ${pack.title} would reach nothing yet.`}
        </Empty>
      )}
      {/* The Ask to join switch goes here, under the people */}

      {pack.formerNames.length ? (
        <Section title="Old addresses">
          <ul className="border border-border bg-card">
            {pack.formerNames.map((former) => (
              <li
                key={former.name}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 text-sm last:border-b-0"
              >
                <span className="min-w-0 [overflow-wrap:anywhere] text-muted-foreground">
                  <Mono className="text-foreground">/p/{former.name}</Mono> · its name until {dayOf(former.until)} ·{' '}
                  {stillThere(former.people)}
                </span>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      size="sm"
                      variant="muted"
                      disabled={free.isPending}
                      aria-label={`Stop answering there (/p/${former.name})`}
                    >
                      Stop answering there
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Stop answering at /p/{former.name}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Anyone still set up with /p/{former.name} is refused from their next call. The name becomes free
                        for another pack.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep answering</AlertDialogCancel>
                      <AlertDialogAction variant="danger" onClick={() => free.mutate(former.name)}>
                        Stop answering there
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <p className="text-sm text-muted-foreground">
        One key for several packs, or for a day?{' '}
        <Link
          to="/agents/new"
          search={{ pack: pack.name }}
          className={cn(LINK, 'text-foreground underline underline-offset-4')}
        >
          Make it under Agents
        </Link>
        .
      </p>
    </div>
  )
}
