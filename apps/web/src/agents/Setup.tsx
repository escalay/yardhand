/**
 * How to connect an agent, one tab per place it can run, from the API's own snippets. Right after a key is made the
 * key is in them; later they hold `<YOUR_KEY>` (the key is never shown twice).
 */
import { useQuery } from '@tanstack/react-query'
import { Code } from '@/ui/Code'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/shadcn/tabs'
import { withKey } from './agents.rules'
import { setupQuery } from './queries'

export const Setup = ({ id, apiKey, first }: { id: string; apiKey: string | null; first?: string }) => {
  const setup = useQuery(setupQuery(id))
  if (setup.isPending) return <Skeleton className="h-48 rounded-none" />
  if (setup.error) return <p className="text-sm text-error">{setup.error.message}</p>
  const { surfaces, keyPlaceholder } = setup.data
  const start = surfaces.some((surface) => surface.id === first) ? first : surfaces[0]?.id
  return (
    <Tabs defaultValue={start} className="flex flex-col gap-3">
      <TabsList className="flex h-auto flex-wrap justify-start">
        {surfaces.map((surface) => (
          <TabsTrigger key={surface.id} value={surface.id}>
            {surface.title}
          </TabsTrigger>
        ))}
      </TabsList>
      {surfaces.map((surface) => (
        <TabsContent key={surface.id} value={surface.id} className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">{surface.where}</p>
          <Code copy label={surface.format}>
            {withKey(surface.snippet, keyPlaceholder, apiKey)}
          </Code>
          {surface.note ? (
            <p className="text-sm text-muted-foreground">{withKey(surface.note, keyPlaceholder, apiKey)}</p>
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  )
}
