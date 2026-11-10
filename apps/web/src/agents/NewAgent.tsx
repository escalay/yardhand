/**
 * Giving an agent a key, the way API-key flows usually go (name → reach → copy, shown once), plus what they leave
 * out: the setup to paste for where it runs, and the wait for its first call. claude.ai needs no key: it signs in
 * with OAuth, so choosing it shows that instead.
 */
import { IconAlertTriangle } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { api, unwrap } from '@/api/client'
import { shortTitleOf } from '@/connections/connections.rules'
import { upstreamsQuery } from '@/connections/queries'
import { expiryOf, LIFETIMES, type Lifetime } from '@/packs/packs.rules'
import { packsQuery } from '@/packs/queries'
import { systemQuery } from '@/shell/queries'
import { Code } from '@/ui/Code'
import { CopyButton } from '@/ui/Copy'
import { Field } from '@/ui/Field'
import { Page, PageHeader, Section } from '@/ui/Page'
import { Button } from '@/ui/shadcn/button'
import { Checkbox } from '@/ui/shadcn/checkbox'
import { Input } from '@/ui/shadcn/input'
import { RadioGroup, RadioGroupItem } from '@/ui/shadcn/radio-group'
import { SURFACE_FOR, type SurfaceId } from './agents.rules'
import { FirstCall } from './FirstCall'
import { type PackChoice, PackPicker } from './PackPicker'
import { Setup } from './Setup'

const Choice = ({ value, title, children }: { value: string; title: string; children?: React.ReactNode }) => (
  <label className="flex cursor-pointer gap-3 border-r border-b border-border p-4 transition-colors has-[[data-state=checked]]:bg-mist/60">
    <RadioGroupItem value={value} className="mt-0.5" />
    <span className="flex flex-col gap-1">
      <span className="text-sm font-medium">{title}</span>
      {children ? <span className="text-sm text-muted-foreground">{children}</span> : null}
    </span>
  </label>
)

type Reach = 'all' | 'some' | 'pack'

export const NewAgent = ({ pack: startPack }: { pack?: string }) => {
  const queries = useQueryClient()
  const upstreams = useQuery(upstreamsQuery)
  const packs = useQuery(packsQuery)
  const system = useQuery(systemQuery)
  const [surface, setSurface] = useState<SurfaceId>('claude-code')
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'read' | 'write'>('write')
  const [reach, setReach] = useState<Reach>(startPack ? 'pack' : 'all')
  const [packChoice, setPackChoice] = useState<PackChoice>({
    packs: startPack ? [startPack] : [],
    pack: startPack ?? '',
  })
  const [lifetime, setLifetime] = useState<Lifetime>(startPack ? '8h' : 'never')
  const [chosen, setChosen] = useState<string[]>([])
  const make = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/clients', {
          body: {
            name: name.trim(),
            scope,
            expiresIn: lifetime,
            ...(reach === 'pack' ? packChoice : { upstreams: reach === 'all' ? 'all' : chosen }),
          },
        }),
      ),
    onSuccess: () => {
      for (const key of [['clients'], ['overview'], ['packs'], ['pack']])
        void queries.invalidateQueries({ queryKey: key })
    },
  })
  const made = make.data

  if (made)
    return (
      <Page className="max-w-3xl">
        <PageHeader
          label="Agents / New key"
          title={
            <>
              <em>{made.name}</em> has a key
            </>
          }
        />
        <div className="flex flex-col gap-3 border border-warn/40 bg-warn-soft p-5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <IconAlertTriangle className="size-4 text-warn" /> Copy it now: you won't see it again
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 truncate border border-border bg-card px-3 py-2 font-mono text-[13px]">
              {made.key}
            </code>
            <CopyButton text={made.key} label="Copy key" variant="default" size="default" />
          </div>
          <p className="text-sm text-muted-foreground">
            Yardhand keeps only a fingerprint of it. {expiryOf(made.expiresAt).text}.
            {made.pack
              ? made.packs.length > 1
                ? ` It opens ${made.packs.join(', ')}, one connection each (${made.pack} at plain /mcp).`
                : ` It sees only the ${made.pack} pack.`
              : ''}{' '}
            Lost it? Revoke this one and make another, it takes ten seconds.
          </p>
        </div>
        <Section title="Paste this where it runs">
          <Setup id={made.id} apiKey={made.key} first={surface} />
        </Section>
        <FirstCall clientId={made.id} name={made.name} since={null} />
        <div className="flex gap-2">
          <Button asChild variant="muted">
            <Link to="/agents/$id" params={{ id: made.id }}>
              Open {made.name}
            </Link>
          </Button>
          <Button variant="ghost" onClick={() => make.reset()}>
            Make another
          </Button>
        </div>
      </Page>
    )

  const oauth = system.data?.features.oauth ?? false
  return (
    <Page className="max-w-3xl">
      <PageHeader
        label="Agents"
        title={
          <>
            Give an agent a <em>key</em>
          </>
        }
      >
        One key per agent or machine, so each one's calls are its own and you can revoke one without touching the rest.
      </PageHeader>

      <Section title="Where it runs">
        <RadioGroup
          value={surface}
          onValueChange={(value) => setSurface(value as SurfaceId)}
          className="grid gap-0 border-t border-l border-border bg-card sm:grid-cols-3"
        >
          {(Object.keys(SURFACE_FOR) as SurfaceId[])
            .filter((id) => id !== 'typescript')
            .map((id) => (
              <Choice key={id} value={id} title={SURFACE_FOR[id]} />
            ))}
        </RadioGroup>
      </Section>

      {surface === 'claude-ai' ? (
        <Section title="claude.ai needs no key">
          <div className="flex flex-col gap-3 border border-border bg-card p-5">
            {oauth ? (
              <>
                <p className="text-sm text-pretty text-muted-foreground">
                  It signs in with OAuth: add Yardhand as a connector, approve it once, and it shows up under Agents
                  after its first call, with every connection and write access (narrow it there).
                </p>
                <Code
                  copy
                  label="claude.ai → Settings → Connectors → Add custom connector"
                >{`Name: Yardhand\nURL:  ${location.origin}/mcp`}</Code>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                This gateway has OAuth off (no OAUTH_SIGNING_KEY), so claude.ai can't sign in. Set one and redeploy, or
                pick another place.
              </p>
            )}
          </div>
        </Section>
      ) : (
        <form
          className="flex flex-col gap-8"
          onSubmit={(event) => {
            event.preventDefault()
            make.mutate()
          }}
        >
          <Section title="Its name">
            <Field
              label="Name"
              hint="Who it is, as you'll see it in Activity: the agent and the machine."
              className="border border-border bg-card p-5"
            >
              {(id) => (
                <Input
                  id={id}
                  required
                  maxLength={80}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={`${SURFACE_FOR[surface].toLowerCase().replace(/ .*/, '')} on my laptop`}
                  autoFocus
                />
              )}
            </Field>
          </Section>
          <Section title="What it may do">
            <RadioGroup
              value={scope}
              onValueChange={(value) => setScope(value as 'read' | 'write')}
              className="grid gap-0 border-t border-l border-border bg-card sm:grid-cols-2"
            >
              <Choice value="write" title="Read and change things">
                Every tool it can reach. For agents you work with.
              </Choice>
              <Choice value="read" title="Only read">
                Tools that change things stay hidden. For scripts and agents that only look things up.
              </Choice>
            </RadioGroup>
          </Section>
          <Section title="What it reaches">
            <RadioGroup
              value={reach}
              onValueChange={(value) => setReach(value as Reach)}
              className="grid gap-0 border-t border-l border-border bg-card sm:grid-cols-3"
            >
              <Choice value="all" title="Everything">
                Every connection, now and later.
              </Choice>
              <Choice value="some" title="Some connections">
                The ones you tick, every tool in them.
              </Choice>
              <Choice value="pack" title="Packs">
                Only their tools, in their wording, one connection each.
              </Choice>
            </RadioGroup>
            {reach === 'some' ? (
              <div className="grid gap-0 border border-border bg-card sm:grid-cols-2">
                {(upstreams.data?._embedded.upstreams ?? []).map((row) => (
                  <label
                    key={row.id}
                    className="flex cursor-pointer items-center gap-3 border-b border-border px-4 py-3 text-sm sm:odd:border-r"
                  >
                    <Checkbox
                      checked={chosen.includes(row.id)}
                      onCheckedChange={(checked) =>
                        setChosen((current) =>
                          checked === true ? [...current, row.id] : current.filter((id) => id !== row.id),
                        )
                      }
                    />
                    {shortTitleOf(row.title)}
                  </label>
                ))}
              </div>
            ) : reach === 'pack' ? (
              <PackPicker packs={packs.data?._embedded.packs ?? []} value={packChoice} onChange={setPackChoice} />
            ) : null}
          </Section>
          <Section title="How long it works">
            <RadioGroup
              value={lifetime}
              onValueChange={(value) => setLifetime(value as Lifetime)}
              className="grid gap-0 border-t border-l border-border bg-card sm:grid-cols-4"
            >
              {LIFETIMES.map((choice) => (
                <Choice key={choice.value} value={choice.value} title={choice.label}>
                  {choice.hint}
                </Choice>
              ))}
            </RadioGroup>
          </Section>
          {make.error ? <p className="text-sm text-error">{make.error.message}</p> : null}
          <div className="flex items-center justify-between gap-3 border-t border-border pt-6">
            <p className="text-sm text-muted-foreground">You can change its reach later; the key stays the same.</p>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={
                !name.trim() ||
                (reach === 'some' && !chosen.length) ||
                (reach === 'pack' && !packChoice.packs.length) ||
                make.isPending
              }
            >
              {make.isPending ? 'Making…' : 'Make the key'}
            </Button>
          </div>
        </form>
      )}
    </Page>
  )
}
