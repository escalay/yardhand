/**
 * Picking a model for one role. The writer gets chat models; a TypeSafe decider gets only TypeSafe's decision models;
 * a chat decider gets chat models. OpenRouter's catalogue comes with names, prices and context sizes; any id can be
 * typed in, since a provider can serve models it doesn't list.
 */
import { IconCheck, IconSelector } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Schemas, unwrap } from '@/api/client'
import { Mono } from '@/ui/Code'
import { Button } from '@/ui/shadcn/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/ui/shadcn/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover'
import { contextLine, priceLine } from './ai.rules'

type Provider = Schemas['AiJob']['provider']['value']
export type ModelRole = 'writer' | 'typesafe' | 'chat'

const HEADING: Record<ModelRole, string> = {
  writer: 'Chat models',
  typesafe: 'TypeSafe decision models',
  chat: 'Chat models',
}

export const ModelPicker = ({
  provider,
  fits,
  value,
  label,
  onPick,
}: {
  provider: Provider
  fits: ModelRole
  value: string
  label: string
  onPick: (model: string) => void
}) => {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const models = useQuery({
    queryKey: ['ai', 'models', provider, fits],
    queryFn: () => unwrap(api.GET('/api/ai/models', { params: { query: { provider, for: fits } } })),
    staleTime: 3_600_000,
  })
  const list = models.data?.models ?? []
  const current = list.find((model) => model.id === value)
  const pick = (model: string) => {
    onPick(model)
    setOpen(false)
    setTyped('')
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="muted"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          className="h-auto w-full justify-between py-2 text-left"
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm">{current?.name ?? value}</span>
            {current && current.name !== current.id ? (
              <Mono className="truncate text-xs text-muted-foreground">{current.id}</Mono>
            ) : null}
          </span>
          <IconSelector className="shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(36rem,92vw)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search by name or id…" value={typed} onValueChange={setTyped} />
          <CommandList className="max-h-96">
            <CommandEmpty>
              {models.isPending ? 'Loading the catalogue…' : models.error ? models.error.message : 'No model matches.'}
            </CommandEmpty>
            {typed.trim() && !list.some((model) => model.id === typed.trim()) ? (
              <CommandGroup heading="Use what you typed">
                <CommandItem value={`__typed ${typed}`} onSelect={() => pick(typed.trim())}>
                  <Mono className="text-[13px]">{typed.trim()}</Mono>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {list.length ? (
              <CommandGroup heading={`${HEADING[fits]} · ${list.length}`}>
                {list.map((model) => (
                  <CommandItem key={model.id} value={`${model.id} ${model.name}`} onSelect={() => pick(model.id)}>
                    <IconCheck className={model.id === value ? 'opacity-100' : 'opacity-0'} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{model.name}</span>
                      <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                        <Mono className="text-xs">{model.id}</Mono>
                        {contextLine(model) ? <span>{contextLine(model)}</span> : null}
                        {priceLine(model) ? <span>{priceLine(model)}</span> : null}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
