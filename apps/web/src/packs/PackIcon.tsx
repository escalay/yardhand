/**
 * A pack's icon: what MCP clients show beside its name, from its open address. The owner uploads an SVG or a PNG,
 * or picks the colour of the monogram (the first letter of its name) every pack starts with.
 */
import { IconUpload } from '@tabler/icons-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef } from 'react'
import { api, local, type Schemas, unwrap } from '@/api/client'
import { cn } from '@/ui/cn'
import { Section } from '@/ui/Page'
import { Button } from '@/ui/shadcn/button'

type Pack = Schemas['Pack']

/** The icon as an image; decorative, since the pack's title is always beside it. */
export const PackIcon = ({ icon, className }: { icon: Schemas['PackIcon']; className?: string }) => (
  <img
    src={local(icon.url)}
    alt=""
    width={96}
    height={96}
    className={cn('size-10 shrink-0 rounded-[22%] bg-muted', className)}
  />
)

const TYPES = { svg: 'image/svg+xml', png: 'image/png' } as const

/** The type to send a picked file as: the browser's, else its extension's. */
const typeOf = (file: File) => file.type || TYPES[file.name.split('.').pop()?.toLowerCase() as keyof typeof TYPES]

export const IconSection = ({ pack }: { pack: Pack }) => {
  const queries = useQueryClient()
  const picker = useRef<HTMLInputElement>(null)
  const path = { params: { path: { name: pack.name } } }
  const done = () => {
    void queries.invalidateQueries({ queryKey: ['pack', pack.name] })
    void queries.invalidateQueries({ queryKey: ['packs'] })
  }
  const change = useMutation({
    mutationFn: (to: { upload: File } | { colour: Pack['palette'][number] } | 'reset') =>
      to === 'reset'
        ? unwrap(api.DELETE('/api/packs/{name}/icon', path))
        : 'colour' in to
          ? unwrap(api.PATCH('/api/packs/{name}/icon', { ...path, body: { colour: to.colour } }))
          : unwrap(
              api.PUT('/api/packs/{name}/icon', {
                ...path,
                body: to.upload as unknown as string,
                bodySerializer: (body) => body,
                headers: { 'content-type': typeOf(to.upload) ?? 'application/octet-stream' },
              }),
            ),
    onSuccess: done,
  })
  const { icon } = pack
  return (
    <Section title="Icon">
      <div className="flex flex-col gap-4 border border-border bg-card p-4">
        <div className="flex items-center gap-4">
          <PackIcon icon={icon} className="size-16" />
          <p className="text-sm text-pretty text-muted-foreground">
            {icon.source === 'upload'
              ? 'Your upload, shown by MCP clients beside the pack’s name.'
              : `The letter ${icon.letter} on a colour: what MCP clients show until you upload an icon.`}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">Monogram colour</span>
          <div className="flex flex-wrap gap-2">
            {pack.palette.map((colour) => (
              <button
                key={colour}
                type="button"
                aria-label={`Colour ${colour}`}
                aria-pressed={icon.source === 'monogram' && icon.colour === colour}
                disabled={change.isPending}
                onClick={() => change.mutate({ colour })}
                style={{ backgroundColor: colour }}
                className="size-7 rounded-full ring-offset-2 ring-offset-card transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60 aria-pressed:ring-2 aria-pressed:ring-foreground motion-reduce:transition-none motion-reduce:hover:scale-100"
              />
            ))}
          </div>
        </div>
        <input
          ref={picker}
          type="file"
          accept=".svg,.png,image/svg+xml,image/png"
          className="hidden"
          aria-label={`An SVG or PNG for ${pack.title}’s icon`}
          onChange={(event) => {
            const upload = event.target.files?.[0]
            if (upload) change.mutate({ upload })
            event.target.value = ''
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="muted" disabled={change.isPending} onClick={() => picker.current?.click()}>
            <IconUpload /> {change.isPending ? 'Saving…' : 'Upload an SVG or PNG'}
          </Button>
          {icon.set ? (
            <Button size="sm" variant="ghost" disabled={change.isPending} onClick={() => change.mutate('reset')}>
              Back to the monogram
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-pretty text-muted-foreground">
          Square, at most 1 MB; a PNG at least 96 × 96. It is drawn at 512 × 512, and an SVG is never served as one.
        </p>
        {change.error ? (
          <p role="alert" className="text-sm text-error">
            {change.error.message}
          </p>
        ) : null}
      </div>
    </Section>
  )
}
