/**
 * What a pack's agents read beyond its tools: the playbooks and the one skill written for it, each with what the
 * checks find in it, a flag when a tool moved under it, and the editor opened in place; then the playbooks and
 * manuals the pack holds from its connections.
 */
import { IconAlertTriangle, IconPencil, IconPlus, IconX } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { api, type Schemas, unwrap } from '@/api/client'
import { Mono } from '@/ui/Code'
import { Section } from '@/ui/Page'
import { Status } from '@/ui/Status'
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
import { AddPlaybook } from './AddPlaybook'
import { DocEditor, type DocTarget } from './DocEditor'
import { argumentsLine, byLevel, findingText, flagAdvice, sectionsLine } from './docs.rules'

type Pack = Schemas['Pack']
type PackItem = Schemas['PackItem']
type Finding = Schemas['PackFinding']
type DocFlag = NonNullable<Schemas['PackDocFlag']>

/** One text of the pack: a playbook of its own by name, or its skill. */
type Doc = { kind: 'playbook'; name: string } | { kind: 'skill' }
const keyOf = (doc: Doc) => (doc.kind === 'skill' ? 'skill' : `playbook:${doc.name}`)
const said = (doc: Doc) => (doc.kind === 'skill' ? 'the skill' : doc.name)

const ItemList = ({
  items,
  empty,
  onRemove,
  link,
}: {
  items: PackItem[]
  empty: string
  onRemove: (name: string) => void
  link: (item: PackItem) => React.ReactNode
}) =>
  items.length ? (
    <ul>
      {items.map((item) => (
        <li key={item.name} className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex flex-wrap items-baseline gap-x-2">
              {link(item)}
              {item.live ? null : <Status tone="error">Not live</Status>}
            </span>
            {item.description ? (
              <span className="line-clamp-2 text-sm text-muted-foreground">{item.description}</span>
            ) : null}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Take ${item.name} out`}
            onClick={() => onRemove(item.name)}
          >
            <IconX />
          </Button>
        </li>
      ))}
    </ul>
  ) : (
    <p className="border-b border-border px-5 py-4 text-sm text-muted-foreground">{empty}</p>
  )

/** What the checks find in a stored text: what a save of it would be refused for, then what is worth a look. */
const Findings = ({ findings }: { findings: Finding[] }) =>
  findings.length ? (
    <ul className="flex flex-col gap-1 text-sm">
      {byLevel(findings).map((finding) => (
        <li
          key={`${finding.code}:${finding.message}`}
          className={finding.level === 'error' ? 'text-error' : 'text-muted-foreground'}
        >
          {findingText(finding)}
        </li>
      ))}
    </ul>
  ) : null

/** A text written for a tool that has since changed or left the pack: what moved, and what clears the flag. */
const FlagNote = ({
  doc,
  flag,
  findings,
  saving,
  problem,
  onKeep,
  onEdit,
}: {
  doc: Doc
  flag: DocFlag
  findings: Finding[]
  saving: boolean
  problem: string | null
  onKeep: () => void
  onEdit: () => void
}) => {
  const advice = flagAdvice(findings)
  return (
    <div className="flex flex-col gap-2 border border-warn/40 bg-warn-soft p-4 text-sm">
      <div className="flex items-start gap-2 font-medium">
        <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
        <span className="min-w-0 break-words">It was {flag.was}, which changed or left the pack since</span>
      </div>
      <p className="line-clamp-6 break-words whitespace-pre-line">{flag.now}</p>
      <p className="text-muted-foreground">{advice.text}</p>
      {problem ? (
        <p role="alert" className="text-error">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {advice.keep ? (
          <Button size="sm" variant="default" disabled={saving} onClick={onKeep}>
            Save {said(doc)} as it is
          </Button>
        ) : null}
        <Button size="sm" variant={advice.keep ? 'ghost' : 'default'} onClick={onEdit}>
          Edit it
        </Button>
      </div>
    </div>
  )
}

const Remove = ({ doc, pack, onRemove }: { doc: Doc; pack: Pack; onRemove: () => void }) => (
  <AlertDialog>
    <AlertDialogTrigger asChild>
      <Button size="icon-sm" variant="ghost" aria-label={`Remove ${said(doc)}`}>
        <IconX />
      </Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Remove {said(doc)}?</AlertDialogTitle>
        <AlertDialogDescription>
          Its text goes with every version of it, and{' '}
          {doc.kind === 'skill'
            ? `${pack.title}’s agents are no longer sent to a skill first.`
            : `${pack.title}’s keys stop getting it at once.`}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Keep it</AlertDialogCancel>
        <AlertDialogAction onClick={onRemove}>Remove</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
)

export const PackDocs = ({
  pack,
  onPatch,
}: {
  pack: Pack
  onPatch: (body: Schemas['PackPatch']) => Promise<unknown>
}) => {
  const queries = useQueryClient()
  const [open, setOpen] = useState<DocTarget | null>(null)
  const [addingPlaybook, setAddingPlaybook] = useState(false)
  const path = { name: pack.name }
  const changed = () => {
    void queries.invalidateQueries({ queryKey: ['pack', pack.name] })
    void queries.invalidateQueries({ queryKey: ['packs'] })
  }
  /** Saves a text again as it is stored: the gateway then reads it as written for the tools as they are now. */
  const keep = useMutation({
    mutationFn: async (doc: Doc): Promise<unknown> => {
      if (doc.kind === 'skill') {
        const { markdown } = await unwrap(api.GET('/api/packs/{name}/skill', { params: { path } }))
        return unwrap(api.PUT('/api/packs/{name}/skill', { params: { path }, body: { markdown } }))
      }
      const params = { path: { ...path, playbook: doc.name } }
      const { markdown } = await unwrap(api.GET('/api/packs/{name}/playbooks/{playbook}', { params }))
      return unwrap(api.PUT('/api/packs/{name}/playbooks/{playbook}', { params, body: { markdown } }))
    },
    onSuccess: changed,
  })
  const remove = useMutation({
    mutationFn: (doc: Doc): Promise<unknown> =>
      doc.kind === 'skill'
        ? unwrap(api.DELETE('/api/packs/{name}/skill', { params: { path } }))
        : unwrap(
            api.DELETE('/api/packs/{name}/playbooks/{playbook}', { params: { path: { ...path, playbook: doc.name } } }),
          ),
    onSuccess: changed,
  })
  /** What the last save or removal of this text was refused for. */
  const problemOf = (doc: Doc) =>
    [keep, remove].flatMap((mutation) =>
      mutation.error && mutation.variables && keyOf(mutation.variables) === keyOf(doc) ? [mutation.error.message] : [],
    )[0] ?? null
  const show = (next: DocTarget | null) => {
    keep.reset()
    remove.reset()
    setOpen(next)
  }

  const writing = open?.kind === 'playbook' && open.name === null
  const editingSkill = open?.kind === 'skill'
  const skill: Doc = { kind: 'skill' }
  const skillProblem = problemOf(skill)
  return (
    <div className="flex flex-col gap-8">
      <Section
        title={`Written for this pack · ${pack.ownPlaybooks.length}`}
        aside={
          writing ? null : (
            <Button size="sm" variant="ghost" onClick={() => show({ kind: 'playbook', name: null })}>
              <IconPlus /> Write a playbook
            </Button>
          )
        }
      >
        <div className="border border-border bg-card">
          {pack.ownPlaybooks.length || writing ? null : (
            <p className="px-5 py-4 text-sm text-muted-foreground">
              No playbook is written for {pack.title} yet. A playbook is a step-by-step way to do one task with this
              pack’s tools: its keys get it as a prompt, through get_playbook and in search.
            </p>
          )}
          {pack.ownPlaybooks.length ? (
            <ul>
              {pack.ownPlaybooks.map((playbook) => {
                const doc: Doc = { kind: 'playbook', name: playbook.name }
                const problem = problemOf(doc)
                return (
                  <li
                    key={playbook.name}
                    className="flex min-w-0 flex-col gap-3 border-b border-border px-5 py-4 last:border-b-0"
                  >
                    {open?.kind === 'playbook' && open.name === playbook.name ? (
                      <DocEditor key={playbook.name} pack={pack} target={open} onDone={() => show(null)} />
                    ) : (
                      <>
                        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                              <span className="text-sm font-medium break-words">{playbook.title}</span>
                              <Mono className="text-xs break-all text-muted-foreground">{playbook.name}</Mono>
                            </span>
                            {playbook.description ? (
                              <span className="line-clamp-2 text-sm text-muted-foreground">{playbook.description}</span>
                            ) : null}
                            <span className="text-xs text-muted-foreground">{argumentsLine(playbook)}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Edit ${playbook.name}`}
                              onClick={() => show({ kind: 'playbook', name: playbook.name })}
                            >
                              <IconPencil /> <span className="hidden sm:inline">Edit</span>
                            </Button>
                            <Remove doc={doc} pack={pack} onRemove={() => remove.mutate(doc)} />
                          </span>
                        </div>
                        <Findings findings={playbook.findings} />
                        {playbook.flag ? (
                          <FlagNote
                            doc={doc}
                            flag={playbook.flag}
                            findings={playbook.findings}
                            saving={keep.isPending}
                            problem={problem}
                            onKeep={() => keep.mutate(doc)}
                            onEdit={() => show({ kind: 'playbook', name: playbook.name })}
                          />
                        ) : problem ? (
                          <p role="alert" className="text-sm text-error">
                            {problem}
                          </p>
                        ) : null}
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : null}
          {writing ? (
            <div className="border-t border-border p-4 first:border-t-0">
              <DocEditor key="new" pack={pack} target={open} onDone={() => show(null)} />
            </div>
          ) : null}
        </div>
      </Section>

      <Section title="Skill">
        <div className="flex min-w-0 flex-col gap-3 border border-border bg-card px-5 py-4">
          {editingSkill ? (
            <DocEditor key="skill" pack={pack} target={open} onDone={() => show(null)} />
          ) : pack.skill ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium break-words">Working with {pack.title}</span>
                  <Mono className="text-xs break-all text-muted-foreground">{pack.skill.uri}</Mono>
                  <span className="text-xs text-muted-foreground">{sectionsLine(pack.skill.sections)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Edit the skill"
                    onClick={() => show({ kind: 'skill', exists: true })}
                  >
                    <IconPencil /> <span className="hidden sm:inline">Edit</span>
                  </Button>
                  <Remove doc={skill} pack={pack} onRemove={() => remove.mutate(skill)} />
                </span>
              </div>
              <Findings findings={pack.skill.findings.filter((finding) => finding.code !== 'missing_section')} />
              {pack.skill.flag ? (
                <FlagNote
                  doc={skill}
                  flag={pack.skill.flag}
                  findings={pack.skill.findings}
                  saving={keep.isPending}
                  problem={skillProblem}
                  onKeep={() => keep.mutate(skill)}
                  onEdit={() => show({ kind: 'skill', exists: true })}
                />
              ) : skillProblem ? (
                <p role="alert" className="text-sm text-error">
                  {skillProblem}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {pack.title} has no skill yet. The skill is what its agents read first: what the pack is for, which tool
                does which job, what is already set, and what it can’t do.
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="self-start"
                onClick={() => show({ kind: 'skill', exists: false })}
              >
                <IconPlus /> Write the skill
              </Button>
            </>
          )}
        </div>
      </Section>

      <Section
        title={`Playbooks from its connections · ${pack.playbooks.length}`}
        aside={
          <Button size="sm" variant="ghost" onClick={() => setAddingPlaybook(true)}>
            <IconPlus /> Add a playbook
          </Button>
        }
      >
        <div className="border border-border bg-card [&_li:last-child]:border-b-0">
          <ItemList
            items={pack.playbooks}
            empty="No playbooks from its connections yet. A playbook brings the tools it uses."
            onRemove={(item) => void onPatch({ remove: { playbooks: [item] } })}
            link={(item) => (
              <span className="flex flex-col">
                <span className="text-sm font-medium">{item.title ?? item.name}</span>
                <Mono className="text-xs text-muted-foreground">{item.name}</Mono>
              </span>
            )}
          />
        </div>
      </Section>
      <Section title={`Manuals · ${pack.manuals.length}`}>
        <div className="border border-border bg-card [&_li:last-child]:border-b-0">
          <ItemList
            items={pack.manuals}
            empty="No manuals. Adding a playbook offers its server's manual."
            onRemove={(item) => void onPatch({ remove: { manuals: [item] } })}
            link={(item) =>
              item.upstream ? (
                <Link
                  to="/connections/$id"
                  params={{ id: item.upstream }}
                  search={{ tab: 'manual' }}
                  className="text-sm font-medium hover:text-primary"
                >
                  {item.title ?? item.name}
                </Link>
              ) : (
                <span className="text-sm font-medium">{item.name}</span>
              )
            }
          />
        </div>
      </Section>
      <AddPlaybook pack={pack} open={addingPlaybook} onOpenChange={setAddingPlaybook} onAdd={onPatch} />
    </div>
  )
}
