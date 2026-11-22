/**
 * One person's own values of a pack's Per person variables: asked in the Share sheet and changed from their row
 * under People. A field left empty gives them the pack's value.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, api, type Person, unwrap } from '@/api/client'
import { Mono } from '@/ui/Code'
import { Field } from '@/ui/Field'
import { Button } from '@/ui/shadcn/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/shadcn/dialog'
import { Input } from '@/ui/shadcn/input'
import { type PersonalField, personValuesOf, placeOf, stop } from './packs.rules'

/** A field per variable, each with what an empty one falls back to, or the problem with it. */
export const ValueFields = ({
  fields,
  texts,
  errors,
  onChange,
}: {
  fields: PersonalField[]
  texts: Record<string, string>
  errors: Record<string, string>
  onChange: (texts: Record<string, string>) => void
}) => (
  <div className="flex flex-col gap-3">
    {fields.map((field) => (
      <Field
        key={field.name}
        label={<Mono className="text-[13px]">{field.name}</Mono>}
        hint={field.hint}
        error={errors[field.name] ?? null}
      >
        {(id) => (
          <Input
            id={id}
            inputMode={field.kind === 'number' ? 'decimal' : undefined}
            placeholder={field.fallback === null ? '' : String(field.fallback)}
            value={texts[field.name] ?? ''}
            onChange={(event) => onChange({ ...texts, [field.name]: event.target.value })}
          />
        )}
      </Field>
    ))}
  </div>
)

/** A refusal of someone's values, beside the variable each problem is about; the rest under the fields. */
export const refusedValues = (error: Error | null) => {
  const byVariable: Record<string, string> = {}
  const rest: string[] = []
  if (!error) return { byVariable, rest }
  const errors = error instanceof ApiError ? error.errors : []
  if (!errors.length) rest.push(error.message)
  for (const problem of errors) {
    const place = placeOf(problem.path)
    if (place && 'variable' in place) byVariable[place.variable] ??= stop(problem.message)
    else rest.push(stop(problem.message))
  }
  return { byVariable, rest }
}

/** Changing one person's values, from their row under People. */
export const ValuesDialog = ({
  pack,
  person,
  fields,
  open,
  onOpenChange,
}: {
  pack: string
  person: Person
  fields: PersonalField[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) => {
  const queries = useQueryClient()
  const [texts, setTexts] = useState(() =>
    Object.fromEntries(Object.entries(person.values).map(([name, value]) => [name, String(value)])),
  )
  const read = personValuesOf(fields, texts)
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT('/api/packs/{name}/people/{client}/values', {
          params: { path: { name: pack, client: person.id } },
          body: { values: read.values },
        }),
      ),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['people'] })
      onOpenChange(false)
    },
  })
  const refused = refusedValues(save.error)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>{person.name}’s values</DialogTitle>
            <DialogDescription>
              The pack fills these inputs with {person.name}’s own values from their next call. Left empty, they get the
              pack’s.
            </DialogDescription>
          </DialogHeader>
          <ValueFields
            fields={fields}
            texts={texts}
            errors={{ ...refused.byVariable, ...read.errors }}
            onChange={setTexts}
          />
          {refused.rest.length ? (
            <div role="alert" className="flex flex-col gap-1 text-sm text-error">
              {refused.rest.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={Object.keys(read.errors).length > 0 || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save values'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
