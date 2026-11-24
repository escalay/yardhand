/**
 * Sharing a pack with one person: who, which app they use, what they can do (asked only when the pack holds tools
 * that change things), for how long, and their own values when the pack fills inputs per person. It ends on the
 * message to send them, their key in it and shown this once, and waits there for their first call.
 */
import { IconAlertTriangle } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { FirstCall } from '@/agents/FirstCall'
import { api, type Pack, unwrap } from '@/api/client'
import { Code } from '@/ui/Code'
import { CopyButton } from '@/ui/Copy'
import { cn } from '@/ui/cn'
import { Field } from '@/ui/Field'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'
import { RadioGroup, RadioGroupItem } from '@/ui/shadcn/radio-group'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/shadcn/sheet'
import { PackIcon } from './PackIcon'
import { refusedValues, ValueFields } from './PersonValues'
import {
  accessOf,
  changesLine,
  changingTools,
  endsOf,
  personalFields,
  personValuesOf,
  SHARE_APPS,
  SHARE_DEFAULT,
  SHARE_LIFETIMES,
  type ShareLifetime,
} from './packs.rules'

/** One question answered by picking one of a few: its label names the group for a screen reader. */
const Question = <Value extends string>({
  label,
  hint,
  value,
  onChange,
  choices,
  columns = 2,
}: {
  label: string
  hint?: string
  value: Value
  onChange: (value: Value) => void
  choices: readonly { value: Value; label: string }[]
  columns?: 2 | 3
}) => {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="text-sm font-medium">
        {label}
      </span>
      {hint ? <span className="text-sm text-muted-foreground">{hint}</span> : null}
      <RadioGroup
        aria-labelledby={id}
        value={value}
        onValueChange={(next) => onChange(next as Value)}
        // In two columns, a last choice left alone takes the row
        className={cn(
          'grid gap-0 border-t border-l border-border bg-card',
          columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2 sm:[&>label:last-child:nth-child(odd)]:col-span-2',
        )}
      >
        {choices.map((choice) => (
          <label
            key={choice.value}
            className="flex cursor-pointer items-center gap-3 border-r border-b border-border px-4 py-3 text-sm transition-colors has-[[data-state=checked]]:bg-mist/60"
          >
            <RadioGroupItem value={choice.value} /> {choice.label}
          </label>
        ))}
      </RadioGroup>
    </div>
  )
}

const ACCESS = [
  { value: 'read', label: 'Read only' },
  { value: 'write', label: 'Can change' },
] as const

/** The form, then the message. Its state lasts as long as the sheet is open: a key is never shown twice. */
const Share = ({ pack, onMade, onDone }: { pack: Pack; onMade: () => void; onDone: () => void }) => {
  const queries = useQueryClient()
  const [name, setName] = useState('')
  const [where, setWhere] = useState(SHARE_APPS[0]?.value ?? 'unsure')
  const [scope, setScope] = useState<'read' | 'write'>('read')
  const [lifetime, setLifetime] = useState<ShareLifetime>(SHARE_DEFAULT)
  const [texts, setTexts] = useState<Record<string, string>>({})
  const fields = personalFields(pack)
  const read = personValuesOf(fields, texts)
  const changing = changingTools(pack)
  const share = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/packs/{name}/people', {
          params: { path: { name: pack.name } },
          body: {
            name: name.trim(),
            app: SHARE_APPS.find((choice) => choice.value === where)?.app ?? null,
            scope,
            expiresIn: lifetime,
            ...(Object.keys(read.values).length ? { values: read.values } : {}),
          },
        }),
      ),
    onSuccess: () => {
      onMade()
      for (const key of [['people'], ['pack'], ['packs'], ['clients'], ['overview']])
        void queries.invalidateQueries({ queryKey: key })
    },
  })
  const made = share.data
  const refused = refusedValues(share.error)

  if (made)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-xl tracking-tight">Send this to {made.name}</h3>
            <p className="text-sm text-muted-foreground first-letter:uppercase">
              {accessOf(made.scope)}, {made.expiresAt ? `until ${endsOf(made).text}` : 'until you revoke it'}.
            </p>
          </div>
          <Code>{made.message}</Code>
          <div className="flex flex-wrap items-center gap-3">
            <CopyButton text={made.message} label="Copy message" variant="primary" size="default" />
            <p className="flex min-w-0 flex-1 basis-64 items-start gap-2 text-sm text-muted-foreground">
              <IconAlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warn" />
              The key is in it and is shown only now: Yardhand keeps a fingerprint of it.
            </p>
          </div>
          <FirstCall clientId={made.id} name={made.name} since={null} pack={pack} />
        </div>
        <div className="flex justify-end border-t border-border px-5 py-4">
          <Button variant="muted" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    )

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        share.mutate()
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        <Field label="Who" hint="Their name, as People and Activity will show it.">
          {(id) => (
            <Input
              id={id}
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Sam"
              autoFocus
            />
          )}
        </Field>
        {/* Signing in from claude.ai or ChatGPT goes here: it makes an invite in place of a key */}
        <Question
          label="Where"
          hint="The app they will add it to: the message has the setup for it."
          value={where}
          onChange={setWhere}
          choices={SHARE_APPS}
        />
        {changing ? (
          <Question
            label="What they can do"
            hint={changesLine(changing)}
            value={scope}
            onChange={setScope}
            choices={ACCESS}
          />
        ) : null}
        <Question label="How long" value={lifetime} onChange={setLifetime} choices={SHARE_LIFETIMES} columns={3} />
        {fields.length ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{name.trim() ? `${name.trim()}’s values` : 'Their values'}</span>
            <span className="text-sm text-muted-foreground">
              {pack.title} fills these inputs with each person’s own value. You can change theirs later under People.
            </span>
            <ValueFields
              fields={fields}
              texts={texts}
              errors={{ ...refused.byVariable, ...read.errors }}
              onChange={setTexts}
            />
          </div>
        ) : null}
        {share.error && (refused.rest.length || !fields.length) ? (
          <p role="alert" className="text-sm text-error">
            {refused.rest.join(' ') || share.error.message}
          </p>
        ) : null}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!name.trim() || Object.keys(read.errors).length > 0 || share.isPending}
        >
          {share.isPending ? 'Sharing…' : 'Share'}
        </Button>
      </div>
    </form>
  )
}

export const ShareSheet = ({
  pack,
  open,
  onOpenChange,
}: {
  pack: Pack
  open: boolean
  onOpenChange: (open: boolean) => void
}) => {
  const [made, setMade] = useState(false)
  const change = (next: boolean) => {
    if (!next) setMade(false)
    onOpenChange(next)
  }
  return (
    <Sheet open={open} onOpenChange={change}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
        // The message is shown once: a stray click beside the sheet does not take it away
        onInteractOutside={(event) => {
          if (made) event.preventDefault()
        }}
      >
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="flex items-center gap-2">
            <PackIcon icon={pack.icon} className="size-6" /> Share {pack.title}
          </SheetTitle>
          <SheetDescription>One person, one key, for this pack alone.</SheetDescription>
        </SheetHeader>
        <Share pack={pack} onMade={() => setMade(true)} onDone={() => change(false)} />
      </SheetContent>
    </Sheet>
  )
}
