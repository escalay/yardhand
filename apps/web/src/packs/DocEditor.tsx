/**
 * Writing one of a pack's own playbooks, or its skill: the Markdown beside what agents read, what the checks a save
 * runs find in it as it is typed (`POST …/checks`, nothing saved), and its older texts to load back. A save the
 * gateway refuses says each problem; the checks shown only hold the button.
 */
import { IconHistory } from '@tabler/icons-react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ApiError, api, type Schemas, unwrap } from '@/api/client'
import { Mono } from '@/ui/Code'
import { Field } from '@/ui/Field'
import { when } from '@/ui/format'
import { Markdown, withoutFrontmatter } from '@/ui/Markdown'
import { Button } from '@/ui/shadcn/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/shadcn/dropdown-menu'
import { Input } from '@/ui/shadcn/input'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { Textarea } from '@/ui/shadcn/textarea'
import {
  byLevel,
  findingsLine,
  findingText,
  playbookNameOf,
  playbookNameProblem,
  refusedLines,
  starterPlaybook,
  starterSkill,
  versionLine,
} from './docs.rules'
import { filledIn } from './packs.rules'
import { packCheckQuery, packPlaybookQuery, packSkillQuery } from './queries'

type Pack = Schemas['Pack']

/** What is being written: one of the pack's own playbooks (`name: null` for a new one), or its skill. */
export type DocTarget = { kind: 'playbook'; name: string | null } | { kind: 'skill'; exists: boolean }

/** How long the text rests before it is checked. */
const CHECK_AFTER = 400

const useSettled = (value: string, ms: number) => {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** A skill's text as the gateway keeps it: its own front matter and first heading are the gateway's to write. */
const skillBodyOf = (text: string) => withoutFrontmatter(text).replace(/^\s*#[ \t]+[^\n]*\n?/, '')

export const DocEditor = ({ pack, target, onDone }: { pack: Pack; target: DocTarget; onDone: () => void }) => {
  const queries = useQueryClient()
  const isSkill = target.kind === 'skill'
  const isNew = isSkill ? !target.exists : target.name === null
  const [title, setTitle] = useState('')
  const [nameTyped, setNameTyped] = useState<string | null>(null)
  const [typed, setTyped] = useState<string | null>(null)
  /** An older text being read; undefined for the served one. */
  const [version, setVersion] = useState<string>()

  const name = isSkill ? '' : (target.name ?? nameTyped ?? playbookNameOf(title))
  const nameProblem =
    !isSkill && target.name === null
      ? playbookNameProblem(name, {
          own: pack.ownPlaybooks.map((playbook) => playbook.name),
          held: pack.playbooks.map((playbook) => playbook.name),
        })
      : null
  const what = isSkill ? 'the skill' : name || 'the playbook'

  const playbook = useQuery({
    ...packPlaybookQuery(pack.name, name, version),
    enabled: !isSkill && !isNew,
    placeholderData: keepPreviousData,
  })
  const skill = useQuery({
    ...packSkillQuery(pack.name, version),
    enabled: isSkill && !isNew,
    placeholderData: keepPreviousData,
  })
  const stored = isSkill ? skill : playbook
  const loaded = isNew ? (isSkill ? starterSkill(pack) : starterPlaybook(title)) : stored.data?.markdown
  const text = typed ?? loaded ?? ''
  const ready = isNew || stored.isSuccess

  // The draft is checked once it rests, under the name it will be saved by when that name is free
  const settledText = useSettled(text, CHECK_AFTER)
  const settledName = useSettled(nameProblem ? '' : name, CHECK_AFTER)
  const checkable = ready && settledText.trim() !== ''
  const check = useQuery({
    ...packCheckQuery(
      pack.name,
      isSkill
        ? { kind: 'skill', markdown: settledText }
        : { kind: 'playbook', ...(settledName ? { name: settledName } : {}), markdown: settledText },
    ),
    enabled: checkable,
    placeholderData: keepPreviousData,
  })
  const findings = checkable ? (check.data?.findings ?? []) : []
  const errors = findings.filter((finding) => finding.level === 'error')
  const checking = checkable && (settledText !== text || check.isFetching)

  const save = useMutation({
    mutationFn: (): Promise<unknown> =>
      isSkill
        ? unwrap(
            api.PUT('/api/packs/{name}/skill', { params: { path: { name: pack.name } }, body: { markdown: text } }),
          )
        : target.name === null
          ? unwrap(
              api.POST('/api/packs/{name}/playbooks', {
                params: { path: { name: pack.name } },
                body: { name, markdown: text },
              }),
            )
          : unwrap(
              api.PUT('/api/packs/{name}/playbooks/{playbook}', {
                params: { path: { name: pack.name, playbook: target.name } },
                body: { markdown: text },
              }),
            ),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['pack', pack.name] })
      void queries.invalidateQueries({ queryKey: ['packs'] })
      toast.success(`Saved ${what}. ${pack.title}’s keys read it from now on.`)
      onDone()
    },
  })
  const refused = save.error
    ? refusedLines({ message: save.error.message, errors: save.error instanceof ApiError ? save.error.errors : [] })
    : []

  if (!isNew && stored.isPending)
    return (
      <div className="flex flex-col gap-3 border border-border bg-background p-4">
        <Skeleton className="h-6 w-48 rounded-none" />
        <Skeleton className="h-72 rounded-none" />
      </div>
    )
  if (!isNew && stored.error)
    return (
      <div className="flex flex-col items-start gap-3 border border-border bg-background p-4 text-sm">
        <p className="text-error">
          Can’t read {what}: {stored.error.message}
        </p>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
    )

  const versions = stored.data?.versions ?? []
  const older = versions.find((candidate) => candidate.id === version)
  const preview = filledIn(
    isSkill ? `# Working with ${pack.title}\n\n${skillBodyOf(text)}` : withoutFrontmatter(text),
    pack.variables,
  )
  return (
    <form
      className="flex min-w-0 flex-col gap-4 border border-border bg-background p-4"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 className="min-w-0 text-sm font-medium break-words">
          {isSkill ? (
            `Working with ${pack.title}`
          ) : target.name === null ? (
            'A new playbook'
          ) : (
            <Mono className="text-[13px]">{target.name}</Mono>
          )}
        </h3>
        {versions.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="sm" variant="ghost" aria-label={`Versions of ${what}`}>
                <IconHistory /> Versions · {versions.length}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[60vh] w-72 overflow-y-auto">
              {versions.map((candidate) => (
                <DropdownMenuItem
                  key={candidate.id}
                  onSelect={() => {
                    // What was typed goes: the text shown is the one picked
                    setTyped(null)
                    setVersion(candidate.live ? undefined : candidate.id)
                  }}
                >
                  <span className="min-w-0 flex-1 text-xs">{versionLine(candidate)}</span>
                  {candidate.id === (version ?? stored.data?.version) ? (
                    <span className="text-xs text-muted-foreground">shown</span>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {!isSkill && target.name === null ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title" hint="Starts the text’s front matter, and the name.">
            {(id) => (
              <Input
                id={id}
                autoFocus
                value={title}
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
              />
            )}
          </Field>
          <Field
            label="Name"
            hint="What agents ask for it by. It can’t be changed later."
            error={name || nameTyped !== null ? nameProblem : null}
          >
            {(id) => (
              <Input
                id={id}
                value={name}
                maxLength={64}
                className="font-mono text-[13px]"
                aria-invalid={Boolean((name || nameTyped !== null) && nameProblem)}
                onChange={(event) => setNameTyped(event.target.value.toLowerCase())}
              />
            )}
          </Field>
        </div>
      ) : null}

      {older ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border border-border bg-muted/60 px-3 py-2 text-sm">
          This is an older text, from {when(older.createdAt)}. Saving it serves it again.
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              setTyped(null)
              setVersion(undefined)
            }}
          >
            Back to the served text
          </Button>
        </p>
      ) : null}

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Field
          label="Text"
          className="min-w-0"
          hint={
            isSkill
              ? 'Markdown. The gateway writes the front matter and the heading. Write a variable as {{name}}, and name tools in backticks, by the names this pack calls them.'
              : 'Markdown. The front matter gives the title, what it is for and the arguments. Write an argument or a variable as {{name}}, number the steps, and name tools in backticks, by the names this pack calls them.'
          }
        >
          {(id) => (
            <Textarea
              id={id}
              autoFocus={isSkill || target.name !== null}
              spellCheck={false}
              disabled={stored.isPlaceholderData}
              value={text}
              maxLength={200_000}
              className="max-h-[70vh] min-h-72 overflow-y-auto font-mono text-[13px] leading-relaxed"
              onChange={(event) => setTyped(event.target.value)}
            />
          )}
        </Field>
        <section aria-label="As agents read it" className="flex min-w-0 flex-col gap-1.5">
          <span aria-hidden="true" className="text-sm font-medium">
            As agents read it
          </span>
          <div className="max-h-[70vh] min-h-72 overflow-y-auto border border-border bg-card p-4">
            <Markdown>{preview.text}</Markdown>
          </div>
          <p className="text-sm text-muted-foreground">
            {isSkill
              ? 'With the pack’s variables as they are now.'
              : 'With the pack’s variables as they are now; an argument is filled with what the agent gives.'}
          </p>
        </section>
      </div>

      <div role="status" className="flex flex-col gap-1 text-sm">
        {!text.trim() ? (
          <p className="text-muted-foreground">Nothing to check yet: write the text.</p>
        ) : check.error ? (
          <p className="text-muted-foreground">
            Can’t check it just now: {check.error.message} Saving checks it again.
          </p>
        ) : !check.data ? (
          <p className="text-muted-foreground">Checking…</p>
        ) : (
          <>
            <p className={errors.length ? 'text-error' : 'text-muted-foreground'}>
              {findingsLine(findings)}
              {checking ? <span className="text-faint-foreground"> · checking…</span> : null}
            </p>
            {findings.length ? (
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {byLevel(findings).map((finding) => (
                  <li
                    key={`${finding.code}:${finding.message}`}
                    className={finding.level === 'error' ? 'text-error' : 'text-muted-foreground'}
                  >
                    {findingText(finding)}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>

      {refused.length ? (
        <div role="alert" className="flex flex-col gap-1 text-sm text-error">
          {refused.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          variant="default"
          disabled={
            save.isPending || !text.trim() || Boolean(nameProblem) || errors.length > 0 || stored.isPlaceholderData
          }
        >
          {save.isPending ? 'Saving…' : isSkill ? 'Save skill' : 'Save playbook'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
