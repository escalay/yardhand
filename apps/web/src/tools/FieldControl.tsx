/** One input of a tool as a control: a switch, a choice, JSON or text, by what its schema says it is. */
import { Input } from '@/ui/shadcn/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/shadcn/select'
import { Switch } from '@/ui/shadcn/switch'
import { Textarea } from '@/ui/shadcn/textarea'
import type { FormField } from './schema-form.rules'

const UNSET = '__unset'

export const FieldControl = ({
  field,
  id,
  value,
  onChange,
}: {
  field: FormField
  id: string
  value: string
  onChange: (value: string) => void
}) => {
  if (field.kind === 'boolean')
    return <Switch id={id} checked={value === 'true'} onCheckedChange={(checked) => onChange(checked ? 'true' : '')} />
  if (field.kind === 'choice')
    return (
      <Select value={value || UNSET} onValueChange={(next) => onChange(next === UNSET ? '' : next)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {field.required ? null : <SelectItem value={UNSET}>Not set</SelectItem>}
          {field.choices.map((choice) => (
            <SelectItem key={choice} value={choice}>
              {choice}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  if (field.kind === 'json' || field.kind === 'long-text')
    return (
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={field.kind === 'json' ? 'font-mono text-[12.5px]' : ''}
        rows={field.kind === 'json' ? 4 : 3}
      />
    )
  return (
    <Input
      id={id}
      inputMode={field.kind === 'number' || field.kind === 'integer' ? 'decimal' : undefined}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}
