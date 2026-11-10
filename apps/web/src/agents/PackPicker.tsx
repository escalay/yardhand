/**
 * Which packs a key opens and which one is its default. Each pack is its own connection (`/mcp/p/<pack>`), so an
 * agent turns them on per project; plain `/mcp` serves the default.
 */
import { Link } from '@tanstack/react-router'
import type { Schemas } from '@/api/client'
import { holdsLine } from '@/packs/packs.rules'
import { Button } from '@/ui/shadcn/button'
import { Checkbox } from '@/ui/shadcn/checkbox'
import { pickPack } from './agents.rules'

export type PackChoice = { packs: string[]; pack: string }

export const PackPicker = ({
  packs,
  value,
  onChange,
}: {
  packs: Schemas['PackCard'][]
  value: PackChoice
  onChange: (next: PackChoice) => void
}) =>
  packs.length ? (
    <div className="flex flex-col border border-border bg-card">
      {packs.map((pack) => {
        const on = value.packs.includes(pack.name)
        const isDefault = on && value.pack === pack.name
        return (
          <div
            key={pack.name}
            className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 last:border-b-0"
          >
            <label className="flex min-w-0 cursor-pointer items-center gap-3 text-sm">
              <Checkbox
                checked={on}
                onCheckedChange={(checked) => onChange(pickPack(value, pack.name, checked === true))}
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{pack.title}</span>
                <span className="text-xs text-muted-foreground">
                  {holdsLine(pack.counts)} · /mcp/p/{pack.name}
                </span>
              </span>
            </label>
            {isDefault && value.packs.length > 1 ? (
              <span className="text-xs tracking-wide text-primary uppercase">Default</span>
            ) : on && value.packs.length > 1 ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ ...value, pack: pack.name })}>
                Make default
              </Button>
            ) : null}
          </div>
        )
      })}
      {value.packs.length > 1 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Each pack is its own connection with the same key, so an agent turns them on per project. Plain /mcp serves
          the default.
        </p>
      ) : null}
    </div>
  ) : (
    <p className="border border-border bg-card p-4 text-sm text-muted-foreground">
      No packs yet.{' '}
      <Link to="/packs" className="text-foreground underline underline-offset-4">
        Make one
      </Link>{' '}
      first: a kit of tools for one kind of work.
    </p>
  )
