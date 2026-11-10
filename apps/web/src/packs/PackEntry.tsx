/**
 * How a pack names one of its tools and which inputs it fixes. A fixed input is filled by the gateway on every call
 * and taken off what the pack's keys read, so `work_inbox` can be the inbox search with the account set to work. The
 * same tool can go in again under another name with other fixed inputs (another account, another project).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Schemas, unwrap } from '@/api/client'
import { FieldControl } from '@/tools/FieldControl'
import { toolQuery } from '@/tools/queries'
import { argumentsOf, type FormField, fieldsOf, valuesOf } from '@/tools/schema-form.rules'
import { Mono } from '@/ui/Code'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'
import { Switch } from '@/ui/shadcn/switch'
import { aliasOf, isAlias } from './packs.rules'

type PackTool = Schemas['PackTool']

/** `copy` puts the tool in again under a new name; `edit` changes this one. */
export type EntryMode = 'edit' | 'copy'

const startingAlias = (tool: PackTool, mode: EntryMode) =>
  mode === 'edit' ? (tool.alias ?? '') : aliasOf(`${tool.title ?? tool.tool.split('.').slice(1).join(' ')} 2`)

export const EntryEditor = ({
  pack,
  tool,
  mode,
  taken,
  onDone,
}: {
  pack: string
  tool: PackTool
  mode: EntryMode
  /** Names already in the pack, so a clash is said before saving. */
  taken: Set<string>
  onDone: () => void
}) => {
  const queries = useQueryClient()
  const detail = useQuery(toolQuery(tool.tool))
  const fields = detail.data ? fieldsOf(detail.data.inputSchema) : []
  const [alias, setAlias] = useState(() => startingAlias(tool, mode))
  const [fixedOn, setFixedOn] = useState(() => new Set(Object.keys(tool.fixed)))
  const [values, setValues] = useState<Record<string, string> | null>(null)
  const shown = values ?? (detail.data ? valuesOf(fields, tool.fixed) : {})

  const chosen: FormField[] = fields
    .filter((field) => fixedOn.has(field.name))
    .map((field) => ({ ...field, required: true }))
  const { args: fixed, errors } = argumentsOf(chosen, shown)
  const name = alias.trim()
  const aliasProblem =
    name === ''
      ? mode === 'copy'
        ? 'A second copy needs its own name.'
        : null
      : !isAlias(name)
        ? 'Lowercase words joined by _ or -, starting with a letter.'
        : name !== tool.name && taken.has(name)
          ? `${name} is already in this pack.`
          : null

  const save = useMutation({
    mutationFn: async (): Promise<unknown> =>
      mode === 'edit'
        ? unwrap(
            api.PATCH('/api/packs/{name}/tools/{tool}', {
              params: { path: { name: pack, tool: tool.name } },
              body: { alias: name || null, fixed },
            }),
          )
        : unwrap(
            api.PATCH('/api/packs/{name}', {
              params: { path: { name: pack } },
              body: { add: { tools: [{ name: tool.tool, reason: 'picked', alias: name, fixed }] } },
            }),
          ),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['pack', pack] })
      void queries.invalidateQueries({ queryKey: ['packs'] })
      onDone()
    },
  })

  return (
    <form
      className="flex flex-col gap-4 border border-border bg-background p-4"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">{mode === 'copy' ? 'Name for the second copy' : 'What its keys call it'}</span>
        <Input
          autoFocus
          value={alias}
          maxLength={64}
          placeholder={tool.tool}
          onChange={(event) => setAlias(event.target.value)}
          aria-invalid={Boolean(aliasProblem)}
        />
        <span className={aliasProblem ? 'text-xs text-error' : 'text-xs text-muted-foreground'}>
          {aliasProblem ??
            (mode === 'copy'
              ? `Runs ${tool.tool} again, with its own fixed inputs: say which account or board it is for.`
              : `Leave empty to keep ${tool.tool}.`)}
        </span>
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Inputs the pack fills</legend>
        <p className="text-xs text-muted-foreground">
          A fixed input is filled on every call and hidden from the pack’s keys: they can’t see or change it.
        </p>
        {detail.isPending ? <p className="text-sm text-muted-foreground">Reading {tool.tool}’s inputs…</p> : null}
        {detail.error ? (
          <p className="text-sm text-error">
            Can’t read {tool.tool}’s inputs: {detail.error.message}. Sync its connection and try again.
          </p>
        ) : null}
        {detail.data && !fields.length ? <p className="text-sm text-muted-foreground">It takes no inputs.</p> : null}
        <ul className="flex flex-col divide-y divide-border border border-border">
          {fields.map((field) => {
            const on = fixedOn.has(field.name)
            const id = `fix-${tool.name}-${field.name}`
            return (
              <li key={field.name} className="flex flex-col gap-2 px-3 py-2.5">
                <div className="flex items-start gap-3">
                  <Switch
                    id={`${id}-on`}
                    checked={on}
                    aria-label={`Fix ${field.name}`}
                    onCheckedChange={(checked) =>
                      setFixedOn((current) => {
                        const next = new Set(current)
                        if (checked) next.add(field.name)
                        else next.delete(field.name)
                        return next
                      })
                    }
                  />
                  <label htmlFor={`${id}-on`} className="flex min-w-0 flex-col gap-0.5">
                    <Mono className="text-[13px]">
                      {field.name}
                      {field.required ? <span className="text-muted-foreground"> · required</span> : null}
                    </Mono>
                    {field.description ? (
                      <span className="line-clamp-2 text-xs text-muted-foreground">{field.description}</span>
                    ) : null}
                  </label>
                </div>
                {on ? (
                  <div className="flex flex-col gap-1 pl-12">
                    <FieldControl
                      field={field}
                      id={id}
                      value={shown[field.name] ?? ''}
                      onChange={(value) => setValues({ ...shown, [field.name]: value })}
                    />
                    {errors[field.name] ? <span className="text-xs text-error">{errors[field.name]}</span> : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      </fieldset>
      {save.error ? <p className="text-sm text-error">{save.error.message}</p> : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          variant="default"
          disabled={Boolean(aliasProblem) || Object.keys(errors).length > 0 || save.isPending || !detail.data}
        >
          {mode === 'copy' ? 'Add the copy' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
