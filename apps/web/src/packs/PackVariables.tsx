/**
 * A pack's variables: values with a name, written `{{name}}` in what the pack fixes or gives as a default, so one
 * change here reaches every tool that writes it. Every save sends the whole set (`PUT …/variables`), and a refusal
 * is said beside the variable it is about.
 */
import { IconPencil, IconPlus, IconX } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, api, type Schemas, unwrap } from '@/api/client'
import { Mono } from '@/ui/Code'
import { Field } from '@/ui/Field'
import { Section } from '@/ui/Page'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/shadcn/select'
import { Switch } from '@/ui/shadcn/switch'
import {
  kindOfValue,
  refusedVariables,
  usedLine,
  VARIABLE_KINDS,
  type VariableKind,
  variableProblem,
  variableValueOf,
} from './packs.rules'
import { packQuery } from './queries'

type Pack = Schemas['Pack']
type Variable = Schemas['PackVariable']
type Sent = Schemas['PackVariablesInput']['variables'][number]

const Problems = ({ lines }: { lines: string[] }) =>
  lines.length ? (
    <div role="alert" className="flex flex-col gap-1 text-sm text-error">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  ) : null

/** One variable as a form: a new one, or a stored one whose name stays (the values that write it go by that name). */
const VariableForm = ({
  start,
  taken,
  problems,
  saving,
  onSave,
  onCancel,
}: {
  start: Variable | null
  taken: Set<string>
  problems: string[]
  saving: boolean
  onSave: (variable: Sent) => void
  onCancel: () => void
}) => {
  const [name, setName] = useState(start?.name ?? '')
  const [kind, setKind] = useState<VariableKind>(start ? kindOfValue(start.value) : 'text')
  const [text, setText] = useState(start ? String(start.value) : '')
  const [description, setDescription] = useState(start?.description ?? '')
  const nameProblem = start ? null : variableProblem(name.trim(), taken)
  const read = variableValueOf(kind, text)
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (read.error === null)
          onSave({ name: name.trim(), value: read.value, description: description.trim() || null })
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,9rem)_minmax(0,1fr)]">
        <Field
          label="Name"
          error={name.trim() ? nameProblem : null}
          hint={start ? 'To rename it, add a new one and move its tools over.' : 'Written {{name}} in a value.'}
        >
          {(id) => (
            <Input
              id={id}
              autoFocus={!start}
              disabled={Boolean(start)}
              value={name}
              maxLength={40}
              className="font-mono text-[13px]"
              aria-invalid={Boolean(name.trim() && nameProblem)}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <Field label="Kind">
          {(id) => (
            <Select value={kind} onValueChange={(next) => setKind(next as VariableKind)}>
              <SelectTrigger id={id} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VARIABLE_KINDS.map((choice) => (
                  <SelectItem key={choice.id} value={choice.id}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field label="Value" error={text.trim() ? read.error : null}>
          {(id) =>
            kind === 'boolean' ? (
              <span className="flex h-9 items-center">
                <Switch
                  id={id}
                  checked={text === 'true'}
                  onCheckedChange={(checked) => setText(checked ? 'true' : '')}
                />
              </span>
            ) : (
              <Input
                id={id}
                autoFocus={Boolean(start)}
                inputMode={kind === 'number' ? 'decimal' : undefined}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            )
          }
        </Field>
      </div>
      <Field label="What it is for" hint="For whoever edits the pack; agents never read it.">
        {(id) => (
          <Input id={id} value={description} maxLength={200} onChange={(event) => setDescription(event.target.value)} />
        )}
      </Field>
      <Problems lines={problems} />
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          variant="default"
          disabled={Boolean(nameProblem) || read.error !== null || saving}
        >
          {saving ? 'Saving…' : 'Save variable'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** The form that is open: a stored variable by name, or a new one. */
type Open = { name: string | null }

export const PackVariables = ({ pack }: { pack: Pack }) => {
  const queries = useQueryClient()
  const [open, setOpen] = useState<Open | null>(null)
  /** The variable the last save was about, so a refusal of a new one is said in its form. */
  const [about, setAbout] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (variables: Sent[]) =>
      unwrap(api.PUT('/api/packs/{name}/variables', { params: { path: { name: pack.name } }, body: { variables } })),
    onSuccess: (data) => {
      queries.setQueryData(packQuery(pack.name).queryKey, data)
      void queries.invalidateQueries({ queryKey: ['packs'] })
      setOpen(null)
    },
  })
  const stored: Sent[] = pack.variables.map(({ name, value, description }) => ({ name, value, description }))
  const send = (name: string, variables: Sent[]) => {
    setAbout(name)
    save.mutate(variables)
  }
  const show = (next: Open | null) => {
    save.reset()
    setOpen(next)
  }

  const names = new Set(stored.map((variable) => variable.name))
  const refused = save.error
    ? refusedVariables(
        { message: save.error.message, errors: save.error instanceof ApiError ? save.error.errors : [] },
        pack.tools,
      )
    : { byVariable: {}, rest: [] }
  const adding = open?.name === null
  const saidOf = (name: string) => refused.byVariable[name] ?? []
  // A problem with a variable that has no row and no open form still has to be said: under the card
  const foot = [
    ...Object.entries(refused.byVariable).flatMap(([name, lines]) =>
      names.has(name) || (adding && name === about) ? [] : lines,
    ),
    ...refused.rest,
  ]

  return (
    <Section
      title={`Variables · ${stored.length}`}
      aside={
        adding ? null : (
          <Button size="sm" variant="ghost" onClick={() => show({ name: null })}>
            <IconPlus /> Add a variable
          </Button>
        )
      }
    >
      <div className="border border-border bg-card">
        {stored.length || adding ? null : (
          <p className="px-5 py-4 text-sm text-muted-foreground">
            No variables yet. A variable is a value with a name: write it as {'{{name}}'} in a fixed or default value,
            change it here once, and every tool that writes it follows.
          </p>
        )}
        {pack.variables.length ? (
          <ul>
            {pack.variables.map((variable) => (
              <li key={variable.name} className="flex flex-col gap-2 border-b border-border px-5 py-3 last:border-b-0">
                {open?.name === variable.name ? (
                  <VariableForm
                    start={variable}
                    taken={names}
                    problems={saidOf(variable.name)}
                    saving={save.isPending}
                    onSave={(next) =>
                      send(
                        next.name,
                        stored.map((kept) => (kept.name === next.name ? next : kept)),
                      )
                    }
                    onCancel={() => show(null)}
                  />
                ) : (
                  <>
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                          <Mono className="text-[13px]">{`{{${variable.name}}}`}</Mono>
                          <span className="text-muted-foreground">=</span>
                          <Mono className="text-[13px] break-all">{String(variable.value)}</Mono>
                        </span>
                        {variable.description ? (
                          <span className="text-sm text-muted-foreground">{variable.description}</span>
                        ) : null}
                        <span className="text-xs text-muted-foreground">{usedLine(variable.usedBy)}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Change ${variable.name}`}
                          disabled={save.isPending}
                          onClick={() => show({ name: variable.name })}
                        >
                          <IconPencil />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Remove ${variable.name}`}
                          disabled={save.isPending}
                          onClick={() =>
                            send(
                              variable.name,
                              stored.filter((kept) => kept.name !== variable.name),
                            )
                          }
                        >
                          <IconX />
                        </Button>
                      </span>
                    </div>
                    <Problems lines={saidOf(variable.name)} />
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {adding ? (
          <div className="border-t border-border px-5 py-4 first:border-t-0">
            <VariableForm
              start={null}
              taken={names}
              problems={about ? saidOf(about) : []}
              saving={save.isPending}
              onSave={(next) => send(next.name, [...stored, next])}
              onCancel={() => show(null)}
            />
          </div>
        ) : null}
        {foot.length ? (
          <div className="border-t border-border px-5 py-3">
            <Problems lines={foot} />
          </div>
        ) : null}
      </div>
    </Section>
  )
}
