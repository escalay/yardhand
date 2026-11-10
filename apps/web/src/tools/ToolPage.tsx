/**
 * One tool: what it does in its own words, what it may do (the owner's setting over the server's hints), pinning, its
 * schema, and the playground beside it.
 */
import { IconPin, IconPinnedFilled } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { EntityActivity } from '@/activity/EntityActivity'
import { api, unwrap } from '@/api/client'
import { Code, Mono } from '@/ui/Code'
import { Empty } from '@/ui/Empty'
import { EntityHeader, EntityTabs } from '@/ui/Entity'
import { Page, Section } from '@/ui/Page'
import { Button } from '@/ui/shadcn/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/shadcn/collapsible'
import { RadioGroup, RadioGroupItem } from '@/ui/shadcn/radio-group'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { Playground } from './Playground'
import { usePins } from './pins'
import { toolQuery } from './queries'
import { ACCESS, type AccessChoice, choiceOf } from './tools.rules'

const parseArgs = (raw: string | undefined) => {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export const ToolPage = ({
  name,
  args,
  tab = 'overview',
}: {
  name: string
  args?: string
  tab?: 'overview' | 'activity'
}) => {
  const navigate = useNavigate()
  const queries = useQueryClient()
  const tool = useQuery(toolQuery(name))
  const pins = usePins()
  const access = useMutation({
    mutationFn: (choice: AccessChoice) =>
      unwrap(
        api.PATCH('/api/tools/{name}', {
          params: { path: { name } },
          body: { access: choice === 'auto' ? null : choice },
        }),
      ),
    onSuccess: (detail) => {
      queries.setQueryData(['tool', name], detail)
      void queries.invalidateQueries({ queryKey: ['tools'] })
      toast.success(`${name}: ${ACCESS[choiceOf(detail.access)].label.toLowerCase()}.`)
    },
    onError: (error) => toast.error(error.message),
  })

  if (tool.isPending)
    return (
      <Page>
        <Skeleton className="h-64 rounded-none" />
      </Page>
    )
  if (tool.error)
    return (
      <Page>
        <Empty
          illustration="not-found"
          title="No tool by that name"
          action={
            <Button asChild variant="muted">
              <Link to="/tools">All tools</Link>
            </Button>
          }
        >
          It may have been removed by its server, or renamed. {tool.error.message}
        </Empty>
      </Page>
    )
  const detail = tool.data
  const pinned = pins.pinned(name)
  return (
    <Page>
      <EntityHeader
        crumbs={[
          { label: 'Tools', to: '/tools' },
          { label: detail.upstream, to: `/connections/${detail.upstream}` },
        ]}
        title={<Mono className="text-2xl sm:text-3xl">{detail.name}</Mono>}
        actions={
          <Button
            variant={pinned ? 'muted' : 'default'}
            onClick={() => pins.toggle(name)}
            disabled={pins.busy}
            aria-pressed={pinned}
          >
            {pinned ? <IconPinnedFilled className="text-primary" /> : <IconPin />}{' '}
            {pinned ? 'Pinned' : 'Pin for every agent'}
          </Button>
        }
      >
        {detail.title ?? (
          <>
            From{' '}
            <Link to="/connections/$id" params={{ id: detail.upstream }} className="underline underline-offset-4">
              {detail.upstream}
            </Link>
          </>
        )}
      </EntityHeader>
      <EntityTabs
        active={tab}
        onPick={(next) =>
          void navigate({
            to: '/tools/$name',
            params: { name },
            search: next === 'activity' ? { tab: 'activity' } : {},
            replace: true,
          })
        }
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'activity', label: 'Activity' },
        ]}
      />

      {tab === 'activity' ? (
        <EntityActivity filter={{ tool: name }} />
      ) : (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_28rem] lg:items-start">
          <div className="flex min-w-0 flex-col gap-8">
            <Section title="What it does">
              <p className="border border-border bg-card p-5 text-sm whitespace-pre-line text-pretty">
                {detail.description || 'Its server gave no description.'}
              </p>
            </Section>
            <Section title="What it may do">
              <RadioGroup
                value={choiceOf(detail.access)}
                onValueChange={(choice) => access.mutate(choice as AccessChoice)}
                className="grid gap-0 border-t border-l border-border bg-card sm:grid-cols-2"
                disabled={access.isPending}
              >
                {(Object.keys(ACCESS) as AccessChoice[]).map((choice) => (
                  <label
                    key={choice}
                    className="flex cursor-pointer gap-3 border-r border-b border-border p-4 transition-colors has-[[data-state=checked]]:bg-mist/60"
                  >
                    <RadioGroupItem value={choice} className="mt-0.5" />
                    <span className="flex flex-col gap-1">
                      <span className="text-sm font-medium">
                        {ACCESS[choice].label}
                        {choice === 'auto' ? (
                          <span className="font-normal text-muted-foreground">
                            {' '}
                            ·{' '}
                            {detail.annotations.readOnlyHint === true
                              ? 'it says it only reads'
                              : 'it says it changes things'}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-sm text-muted-foreground">{ACCESS[choice].body}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </Section>
            <Collapsible>
              <Section
                title="Input schema"
                aside={
                  <CollapsibleTrigger className="text-muted-foreground hover:text-foreground">Show</CollapsibleTrigger>
                }
              >
                <CollapsibleContent>
                  <Code copy>{JSON.stringify(detail.inputSchema, null, 2)}</Code>
                </CollapsibleContent>
              </Section>
            </Collapsible>
            {detail.upstreamInstructions ? (
              <Collapsible>
                <Section
                  title={`How ${detail.upstream} says to use its tools`}
                  aside={
                    <CollapsibleTrigger className="text-muted-foreground hover:text-foreground">
                      Show
                    </CollapsibleTrigger>
                  }
                >
                  <CollapsibleContent>
                    <p className="border border-border bg-card p-5 text-sm whitespace-pre-line text-pretty">
                      {detail.upstreamInstructions}
                    </p>
                  </CollapsibleContent>
                </Section>
              </Collapsible>
            ) : null}
          </div>
          <div className="lg:sticky lg:top-16">
            <Playground key={detail.name} tool={detail} initialArgs={parseArgs(args)} />
          </div>
        </div>
      )}
    </Page>
  )
}
