/**
 * The public front page at `/`: what this is and how an agent connects, no data. Agents that ask for Markdown get the
 * guide instead (the gateway answers that before this page).
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { Backdrop } from '../ui/Backdrop'

const origin = location.origin

const Landing = () => (
  <main className="min-h-svh">
    <section className="relative flex min-h-svh flex-col overflow-hidden bg-inverse">
      <Backdrop />
      <div className="relative mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-6 sm:px-8">
        <span className="text-[13px] font-medium tracking-[0.22em] text-inverse-foreground uppercase">Yardhand</span>
        <a href="/app" className="text-sm text-inverse-foreground/80 hover:text-inverse-foreground">
          Sign in
        </a>
      </div>
      <div className="relative mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-6 px-6 pb-24 sm:px-8">
        <h1 className="max-w-3xl text-5xl tracking-tight text-balance text-inverse-foreground sm:text-6xl">
          One door for <em>every</em> tool
        </h1>
        <p className="max-w-xl text-lg text-pretty text-inverse-foreground/75">
          A private gateway: MCP servers and APIs behind one address, their keys kept here once, every call on the
          record. Agents connect over MCP, scripts over REST.
        </p>
      </div>
    </section>
    <section className="mx-auto grid max-w-5xl gap-0 border-l border-border px-6 py-20 sm:grid-cols-3 sm:px-8">
      {[
        [
          'Agents',
          `${origin}/mcp`,
          'Add it as an MCP server with the key you were given, or as a claude.ai connector (OAuth).',
        ],
        ['Scripts', `${origin}/api`, 'Every tool is a REST call; the API describes itself at /openapi.json.'],
        ['Guide', `${origin}/llms.txt`, 'How to find a tool, read it and run it, written for agents.'],
      ].map(([title, address, body]) => (
        <div key={title} className="flex flex-col gap-3 border-r border-b border-t border-border p-6">
          <span className="text-xs tracking-wide text-muted-foreground uppercase">
            {'/// '}
            {title}
          </span>
          <span className="font-mono text-[13px] break-all">{address}</span>
          <p className="text-sm text-pretty text-muted-foreground">{body}</p>
        </div>
      ))}
    </section>
  </main>
)

const root = document.getElementById('landing')
if (root)
  createRoot(root).render(
    <StrictMode>
      <Landing />
    </StrictMode>,
  )
