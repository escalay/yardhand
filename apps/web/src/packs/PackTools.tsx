/**
 * A pack's variables, then its tools: each with why it is in, the name its keys call it, the inputs the pack fixes or
 * gives a default and what its keys read, which the owner can reword (the upstream's text stays beside it). When the
 * upstream rewrites a tool the pack words, or stops taking a value the pack sets, the row says what changed until
 * the owner decides.
 */
import {
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconCopyPlus,
  IconPencil,
  IconPlus,
  IconSparkles,
  IconX,
} from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { api, type Schemas, unwrap } from '@/api/client'
import { Mono } from '@/ui/Code'
import { Section } from '@/ui/Page'
import { Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import { Textarea } from '@/ui/shadcn/textarea'
import { AddTools } from './AddTools'
import { EntryEditor, type EntryMode } from './PackEntry'
import { PackVariables } from './PackVariables'
import { failsLine, inputsLine, problemLines, reasonOf, setsAccount, withAccountLabels, wordingOf } from './packs.rules'

type Pack = Schemas['Pack']
type PackTool = Schemas['PackTool']

const useWording = (pack: string) => {
  const queries = useQueryClient()
  return useMutation({
    mutationFn: ({ tool, description }: { tool: string; description: string | null }) =>
      unwrap(
        api.PUT('/api/packs/{name}/tools/{tool}/wording', {
          params: { path: { name: pack, tool } },
          body: { description },
        }),
      ),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['pack', pack] })
      void queries.invalidateQueries({ queryKey: ['packs'] })
    },
  })
}

const Flag = ({ tool, pack }: { tool: PackTool; pack: string }) => {
  const save = useWording(pack)
  if (!tool.flag) return null
  return (
    <div className="flex flex-col gap-3 border border-warn/40 bg-warn-soft p-4 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <IconAlertTriangle className="size-4 text-warn" /> {tool.upstream} rewrote this tool since you worded it
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-xs tracking-wide text-muted-foreground uppercase">Was</span>
          <p className="whitespace-pre-line text-muted-foreground line-through decoration-error/40">{tool.flag.was}</p>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs tracking-wide text-muted-foreground uppercase">Now</span>
          <p className="whitespace-pre-line">{tool.flag.now}</p>
        </div>
      </div>
      <p className="text-muted-foreground">Agents keep reading your wording, with the new schema, until you decide.</p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="default"
          disabled={save.isPending}
          onClick={() => save.mutate({ tool: tool.name, description: tool.wording })}
        >
          Keep my wording
        </Button>
        <Button size="sm" variant="ghost" onClick={() => save.mutate({ tool: tool.name, description: null })}>
          Use theirs
        </Button>
      </div>
    </div>
  )
}

/** Every value the pack sets that the live tool no longer takes: an input it dropped, a value its schema refuses. */
const InputProblems = ({ tool }: { tool: PackTool }) => {
  const lines = problemLines(tool)
  return lines.length ? (
    <div className="flex items-start gap-2 border border-error/40 bg-error/5 p-3 text-sm">
      <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-error" />
      <span>
        {lines.join('; ')}. {tool.upstream} changed the tool after this pack set {lines.length === 1 ? 'it' : 'them'}:{' '}
        {failsLine(tool)} (Name & inputs).
      </span>
    </div>
  ) : null
}

const ToolRow = ({
  tool,
  pack,
  taken,
  variables,
  titleOf,
  labelOf,
  onRemove,
}: {
  tool: PackTool
  pack: string
  taken: Set<string>
  variables: Pack['variables']
  titleOf: (playbook: string) => string
  labelOf: (upstream: string, account: string) => string | undefined
  onRemove: () => void
}) => {
  const [editing, setEditing] = useState(false)
  const [entry, setEntry] = useState<EntryMode | null>(null)
  // An account shows by its label where the pack's connection lists it
  const sets = inputsLine(withAccountLabels(tool, (account) => labelOf(tool.upstream, account)))
  const [draft, setDraft] = useState('')
  const save = useWording(pack)
  const shown = wordingOf(tool)
  return (
    <li className="flex flex-col gap-3 border-b border-border px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link to="/tools/$name" params={{ name: tool.tool }} className="hover:text-primary">
            <Mono className="text-[13px]">{tool.name}</Mono>
          </Link>
          {tool.alias ? <span className="text-xs text-muted-foreground">runs {tool.tool}</span> : null}
          {tool.needsWrite ? <span className="text-xs text-muted-foreground">changes things</span> : null}
          {tool.live ? null : <Status tone="error">Not live</Status>}
        </span>
        <span className="flex flex-wrap items-center gap-1">
          <span className="mr-2 text-xs text-muted-foreground">{reasonOf(tool, titleOf)}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!tool.live}
            aria-label={`Name and inputs of ${tool.name}`}
            onClick={() => setEntry('edit')}
          >
            <IconAdjustmentsHorizontal /> <span className="hidden sm:inline">Name & inputs</span>
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={!tool.live}
            aria-label={`Add ${tool.tool} again under another name`}
            title="Add again under another name (another account, another project)"
            onClick={() => setEntry('copy')}
          >
            <IconCopyPlus />
          </Button>
          {editing ? null : (
            <Button
              size="sm"
              variant="ghost"
              disabled={!tool.live}
              onClick={() => {
                setDraft(tool.wording ?? tool.upstreamDescription ?? '')
                setEditing(true)
              }}
            >
              <IconPencil /> {tool.wording ? 'Reword' : 'Word it'}
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" aria-label={`Take ${tool.name} out`} onClick={onRemove}>
            <IconX />
          </Button>
        </span>
      </div>
      {sets ? (
        <p className="text-xs text-muted-foreground">
          <span className="tracking-wide text-primary uppercase">Inputs</span>{' '}
          <Mono className="text-xs break-words">{sets}</Mono>
        </p>
      ) : null}
      {entry ? (
        <EntryEditor
          pack={pack}
          tool={tool}
          mode={entry}
          taken={taken}
          variables={variables}
          onDone={() => setEntry(null)}
        />
      ) : null}
      {editing ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate({ tool: tool.name, description: draft.trim() }, { onSuccess: () => setEditing(false) })
          }}
        >
          <Textarea
            autoFocus
            rows={Math.min(10, Math.max(3, draft.split('\n').length + 1))}
            value={draft}
            maxLength={8000}
            aria-label={`What the pack's keys read for ${tool.name}`}
            onChange={(event) => setDraft(event.target.value)}
          />
          <details className="text-sm">
            <summary className="cursor-pointer text-xs tracking-wide text-muted-foreground uppercase select-none">
              {tool.upstream}’s own text
            </summary>
            <p className="mt-2 whitespace-pre-line text-muted-foreground">{tool.upstreamDescription}</p>
          </details>
          {save.error ? <p className="text-sm text-error">{save.error.message}</p> : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="default" disabled={!draft.trim() || save.isPending}>
              Save wording
            </Button>
            {tool.wording ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  save.mutate({ tool: tool.name, description: null }, { onSuccess: () => setEditing(false) })
                }
              >
                Back to {tool.upstream}’s
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-1">
          {shown.own ? <span className="text-xs tracking-wide text-primary uppercase">Pack wording</span> : null}
          <p className="line-clamp-4 text-sm whitespace-pre-line text-pretty text-muted-foreground">{shown.text}</p>
        </div>
      )}
      <Flag tool={tool} pack={pack} />
      <InputProblems tool={tool} />
    </li>
  )
}

export const PackTools = ({
  pack,
  titleOf,
  onPatch,
  onBuild,
  adding,
  onAdding,
}: {
  pack: Pack
  titleOf: (playbook: string) => string
  onPatch: (body: Schemas['PackPatch']) => Promise<unknown>
  /** Build the empty pack with AI, from what it is for and a few example tasks. */
  onBuild: () => void
  /** The dialog that adds tools is open: kept in the address, so the Overview can lead straight to it. */
  adding: boolean
  onAdding: (open: boolean) => void
}) => {
  const taken = new Set(pack.tools.map((tool) => tool.name))
  const accountUpstreams = [...new Set(pack.tools.filter(setsAccount).map((tool) => tool.upstream))]
  const accounts = useQuery({
    queryKey: ['accounts', accountUpstreams],
    enabled: accountUpstreams.length > 0,
    staleTime: 60_000,
    queryFn: async () =>
      (
        await Promise.all(
          accountUpstreams.map(async (id) =>
            (
              await unwrap(api.GET('/api/upstreams/{id}/accounts', { params: { path: { id } } })).catch(() => ({
                _embedded: { accounts: [] },
              }))
            )._embedded.accounts.map((account) => [`${id}:${account.id}`, account.label] as const),
          ),
        )
      ).flat(),
  })
  const labels = new Map(accounts.data ?? [])
  const labelOf = (upstream: string, account: string) => labels.get(`${upstream}:${account}`)
  return (
    <>
      <PackVariables pack={pack} />
      <Section title={`Tools · ${pack.tools.length}`}>
        <div className="border border-border bg-card">
          {pack.tools.length ? (
            <ul>
              {pack.tools.map((tool) => (
                <ToolRow
                  key={tool.name}
                  tool={tool}
                  pack={pack.name}
                  taken={taken}
                  variables={pack.variables}
                  titleOf={titleOf}
                  labelOf={labelOf}
                  onRemove={() => void onPatch({ remove: { tools: [tool.name] } })}
                />
              ))}
            </ul>
          ) : (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              No tools yet. Add a playbook and the tools it uses come with it, pick them yourself, or build it with AI
              from what it is for and a few example tasks.
            </p>
          )}
          <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
            <Button size="sm" variant={pack.tools.length ? 'ghost' : 'primary'} onClick={() => onAdding(true)}>
              <IconPlus /> Add tools
            </Button>
            {pack.tools.length ? null : (
              <Button size="sm" variant="muted" onClick={onBuild}>
                <IconSparkles /> Build with AI
              </Button>
            )}
          </div>
        </div>
      </Section>
      <AddTools
        pack={pack}
        open={adding}
        onOpenChange={onAdding}
        onAdd={(drafts) => onPatch({ add: { tools: drafts.map((draft) => ({ ...draft, reason: 'picked' })) } })}
      />
    </>
  )
}
