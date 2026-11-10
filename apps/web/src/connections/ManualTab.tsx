/**
 * A connection's manual: how the server says its tools should be used, as agents read it. The gateway's note sits on
 * top, apart, so the owner sees exactly what was added; its other files fold below. Reading it here is logged as the
 * owner's read.
 */
import { useQuery } from '@tanstack/react-query'
import { Code, Mono } from '@/ui/Code'
import { Markdown, withoutFrontmatter } from '@/ui/Markdown'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { manualQuery, manualsQuery } from './queries'

const OneManual = ({ name, upstream }: { name: string; upstream: string }) => {
  const manual = useQuery(manualQuery(name))
  if (manual.isPending) return <Skeleton className="h-64 rounded-none" />
  if (manual.error) return <p className="border border-border bg-card p-5 text-sm text-error">{manual.error.message}</p>
  const { skill, description, note, original, text, references } = manual.data
  const files = Object.entries(references).sort(([a], [b]) => a.localeCompare(b))
  return (
    <article className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted-foreground">skill · {skill}</span>
        <p className="text-sm text-pretty text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-col gap-2 border border-primary/30 bg-primary/5 p-4">
        <span className="text-xs tracking-wide text-muted-foreground uppercase">What Yardhand adds on top</span>
        <Markdown>{note.replace(/^> ?/gm, '')}</Markdown>
      </div>
      <div className="border border-border bg-card p-5">
        <Markdown>{withoutFrontmatter(original ?? text)}</Markdown>
      </div>
      {files.length ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs tracking-wide text-muted-foreground uppercase">
            Its other files · {files.length}
          </span>
          <ul className="border border-border bg-card">
            {files.map(([path, body]) => (
              <li key={path} className="border-b border-border last:border-b-0">
                <details className="group">
                  <summary className="cursor-pointer px-4 py-3 font-mono text-[13px] select-none hover:bg-muted">
                    {path}
                  </summary>
                  <div className="border-t border-border px-5 py-4">
                    <Markdown>{withoutFrontmatter(body)}</Markdown>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <span className="text-xs tracking-wide text-muted-foreground uppercase">How agents get it</span>
        <Code>{`read_resource "gateway://u/${upstream}/manual"      (any MCP client)\nGET /api/manuals/${name}                            (REST)`}</Code>
        <p className="text-sm text-muted-foreground">
          Clients that speak the Skills extension also see it as a skill. <Mono>describe_tool</Mono> points to it for
          every {upstream} tool.
        </p>
      </div>
    </article>
  )
}

export const ManualTab = ({ upstream }: { upstream: string }) => {
  const manuals = useQuery(manualsQuery(upstream))
  if (manuals.isPending) return <Skeleton className="h-64 rounded-none" />
  const list = manuals.data?._embedded.manuals ?? []
  if (!list.length)
    return (
      <p className="border border-border bg-card p-5 text-sm text-muted-foreground">
        This server has no manual. Agents go by its tools’ descriptions and its instructions.
      </p>
    )
  return (
    <div className="flex flex-col gap-10">
      {list.map((manual) => (
        <OneManual key={manual.name} name={manual.name} upstream={upstream} />
      ))}
    </div>
  )
}
