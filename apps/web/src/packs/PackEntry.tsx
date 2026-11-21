/**
 * How a pack names one of its tools and who fills each of its inputs. Fixed: the gateway, on every call, and the
 * input is taken off what the pack's keys read, so `work_inbox` can be the inbox search with the account set to work.
 * Default: shown with the pack's value, which the agent may replace. Anything else is the agent's. A value may write
 * the pack's variables as `{{name}}`. The same tool can go in again under another name with other values (another
 * account, another project).
 */
import { IconAlertTriangle, IconBraces, IconX } from '@tabler/icons-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, api, type Schemas, unwrap } from '@/api/client'
import { FieldControl } from '@/tools/FieldControl'
import { toolQuery } from '@/tools/queries'
import { type FormField, fieldsOf, valuesOf } from '@/tools/schema-form.rules'
import { Mono } from '@/ui/Code'
import { Button } from '@/ui/shadcn/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/ui/shadcn/dropdown-menu'
import { Input } from '@/ui/shadcn/input'
import { RadioGroup, RadioGroupItem } from '@/ui/shadcn/radio-group'
import {
  aliasOf,
  filledIn,
  INPUT_MODES,
  type InputMode,
  inputValuesOf,
  isAlias,
  modeOf,
  refusedInputs,
  uncheckedLine,
  withVariable,
  writesVariable,
} from './packs.rules'

type PackTool = Schemas['PackTool']
type Variable = Schemas['PackVariable']

/** `copy` puts the tool in again under a new name; `edit` changes this one. */
export type EntryMode = 'edit' | 'copy'

const startingAlias = (tool: PackTool, mode: EntryMode) =>
  mode === 'edit' ? (tool.alias ?? '') : aliasOf(`${tool.title ?? tool.tool.split('.').slice(1).join(' ')} 2`)

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** Writes one of the pack's variables into a value. */
const VariablePicker = ({
  input,
  variables,
  onPick,
}: {
  input: string
  variables: Variable[]
  onPick: (name: string) => void
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button type="button" size="sm" variant="ghost" className="shrink-0" aria-label={`Use a variable for ${input}`}>
        <IconBraces /> <span className="hidden sm:inline">Variable</span>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="max-h-[60vh] w-64 overflow-y-auto">
      {variables.length ? (
        variables.map((variable) => (
          <DropdownMenuItem key={variable.name} onSelect={() => onPick(variable.name)}>
            <Mono className="min-w-0 flex-1 truncate text-xs">{`{{${variable.name}}}`}</Mono>
            <span className="max-w-24 truncate text-xs text-muted-foreground">{String(variable.value)}</span>
          </DropdownMenuItem>
        ))
      ) : (
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          This pack has no variables yet: add one under Variables, above its tools.
        </DropdownMenuLabel>
      )}
    </DropdownMenuContent>
  </DropdownMenu>
)

/** One input: who fills it, and the pack's value when the pack does. */
const InputRow = ({
  field,
  id,
  mode,
  text,
  variables,
  stored,
  problem,
  onMode,
  onText,
}: {
  field: FormField
  id: string
  mode: InputMode
  text: string
  variables: Variable[]
  /** What the gateway says of the value as stored; shown until the value is changed. */
  stored: string | null
  problem: string | null
  onMode: (mode: InputMode) => void
  onText: (text: string) => void
}) => {
  const filled = filledIn(text, variables)
  // A switch or a list of choices can't show a variable: it is shown as written, with a way back to the control
  const asWritten = writesVariable(text) && (field.kind === 'boolean' || field.kind === 'choice')
  return (
    <li className="flex flex-col gap-2 px-3 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Mono className="text-[13px]">
          {field.name}
          {field.required ? <span className="text-muted-foreground"> · required</span> : null}
        </Mono>
        {field.description ? (
          <span className="line-clamp-2 text-xs text-muted-foreground">{field.description}</span>
        ) : null}
      </div>
      <RadioGroup
        value={mode}
        onValueChange={(next) => onMode(next as InputMode)}
        aria-label={`Who fills ${field.name}`}
        className="flex flex-wrap gap-x-5 gap-y-2"
      >
        {INPUT_MODES.map((choice) => (
          <label key={choice.id} className="flex cursor-pointer items-center gap-2 text-sm">
            <RadioGroupItem value={choice.id} /> {choice.label}
          </label>
        ))}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">{INPUT_MODES.find((choice) => choice.id === mode)?.hint}</p>
      {mode === 'agent' ? null : (
        <div className="flex flex-col gap-1">
          {asWritten ? null : (
            <label htmlFor={id} className="sr-only">
              Value of {field.name}
            </label>
          )}
          <div className="flex items-start gap-2">
            <div className="flex min-h-9 min-w-0 flex-1 items-center">
              {asWritten ? (
                <span className="flex min-w-0 items-center gap-1">
                  <Mono className="truncate text-[13px]">{text.trim()}</Mono>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Stop using a variable for ${field.name}`}
                    onClick={() => onText('')}
                  >
                    <IconX />
                  </Button>
                </span>
              ) : (
                <FieldControl field={field} id={id} value={text} onChange={onText} />
              )}
            </div>
            <VariablePicker
              input={field.name}
              variables={variables}
              onPick={(name) => onText(withVariable(field, text, name))}
            />
          </div>
          {stored ? (
            <span className="text-xs text-error">{stored}. Calls fail until you change the value.</span>
          ) : problem ? (
            <span className="text-xs text-error">{problem}</span>
          ) : null}
          {filled.undeclared.map((word) => (
            <span key={word} className="text-xs text-muted-foreground">
              No variable {word}: sent as written.
            </span>
          ))}
          {filled.text !== text ? (
            <span className="text-xs text-muted-foreground">Sent as {filled.text.trim()}.</span>
          ) : null}
        </div>
      )}
    </li>
  )
}

export const EntryEditor = ({
  pack,
  tool,
  mode,
  taken,
  variables,
  onDone,
}: {
  pack: string
  tool: PackTool
  mode: EntryMode
  /** Names already in the pack, so a clash is said before saving. */
  taken: Set<string>
  /** The pack's variables, for a value to write. */
  variables: Variable[]
  onDone: () => void
}) => {
  const queries = useQueryClient()
  const detail = useQuery(toolQuery(tool.tool))
  const fields = detail.data ? fieldsOf(detail.data.inputSchema) : []
  const [alias, setAlias] = useState(() => startingAlias(tool, mode))
  const [picked, setPicked] = useState<Record<string, InputMode>>({})
  const [typed, setTyped] = useState<Record<string, string> | null>(null)
  const stored = { ...tool.fixed, ...tool.defaults }
  const texts = typed ?? (detail.data ? valuesOf(fields, stored) : {})
  const modes = Object.fromEntries(fields.map((field) => [field.name, picked[field.name] ?? modeOf(tool, field.name)]))

  const { fixed, defaults, errors } = inputValuesOf(fields, modes, texts)
  const sets = { ...fixed, ...defaults }
  const changed = (input: string) =>
    modes[input] !== modeOf(tool, input) || JSON.stringify(sets[input]) !== JSON.stringify(stored[input])
  const storedProblems = tool.lostInputs.length + tool.inputs.filter((input) => input.problem).length
  const dirty = fields.some((field) => changed(field.name))
  const unchecked = uncheckedLine(tool)

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
              body: { alias: name || null, fixed, defaults },
            }),
          )
        : unwrap(
            api.PATCH('/api/packs/{name}', {
              params: { path: { name: pack } },
              body: { add: { tools: [{ name: tool.tool, reason: 'picked', alias: name, fixed, defaults }] } },
            }),
          ),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['pack', pack] })
      void queries.invalidateQueries({ queryKey: ['packs'] })
      onDone()
    },
  })
  const refused = save.error
    ? refusedInputs(
        { message: save.error.message, errors: save.error instanceof ApiError ? save.error.errors : [] },
        [tool.name, name || tool.tool],
        fields.map((field) => field.name),
      )
    : null

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
              ? `Runs ${tool.tool} again, with its own values: say which account or board it is for.`
              : `Leave empty to keep ${tool.tool}.`)}
        </span>
      </label>
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Inputs</legend>
        <p className="text-xs text-muted-foreground">
          Who fills each input: the pack on every call, the pack unless the agent sends its own, or the agent. A value
          can write a variable of the pack as {'{{name}}'}.
        </p>
        {detail.isPending ? <p className="text-sm text-muted-foreground">Reading {tool.tool}’s inputs…</p> : null}
        {detail.error ? (
          <p className="text-sm text-error">
            Can’t read {tool.tool}’s inputs: {detail.error.message}. Sync its connection and try again.
          </p>
        ) : null}
        {detail.data && !fields.length ? <p className="text-sm text-muted-foreground">It takes no inputs.</p> : null}
        {fields.length || tool.lostInputs.length ? (
          <ul className="flex flex-col divide-y divide-border border border-border">
            {fields.map((field) => (
              <InputRow
                key={field.name}
                field={field}
                id={`set-${tool.name}-${field.name}`}
                mode={modes[field.name] ?? 'agent'}
                text={texts[field.name] ?? ''}
                variables={variables}
                stored={
                  changed(field.name) ? null : (tool.inputs.find((input) => input.name === field.name)?.problem ?? null)
                }
                problem={errors[field.name] ?? refused?.byInput[field.name] ?? null}
                onMode={(next) => setPicked({ ...picked, [field.name]: next })}
                onText={(text) => setTyped({ ...texts, [field.name]: text })}
              />
            ))}
            {tool.lostInputs.map((input) => (
              <li key={input} className="flex items-start gap-2 px-3 py-3 text-sm">
                <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-error" />
                <span>
                  <Mono className="text-[13px]">{input}</Mono>: {tool.tool} no longer takes it. Saving drops it from
                  this pack.
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </fieldset>
      {refused ? (
        <div role="alert" className="flex flex-col gap-1 text-sm text-error">
          {refused.rest.length ? (
            refused.rest.map((line) => <p key={line}>{line}</p>)
          ) : (
            <p>Not saved: change the values marked above.</p>
          )}
        </div>
      ) : mode === 'copy' || !detail.data ? null : storedProblems ? (
        <p className="text-sm text-error">
          {plural(storedProblems, 'value')} {storedProblems === 1 ? 'doesn’t' : 'don’t'} fit the tool’s current schema:
          change {storedProblems === 1 ? 'it' : 'them'} and save.
        </p>
      ) : dirty ? (
        <p className="text-sm text-muted-foreground">Each value is checked against the tool’s schema when you save.</p>
      ) : unchecked ? (
        <p className="text-sm text-muted-foreground">{unchecked}</p>
      ) : (
        <p className="text-sm text-muted-foreground">✓ Every value fits the tool’s current schema</p>
      )}
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
