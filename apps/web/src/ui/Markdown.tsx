/**
 * Markdown from upstreams (manuals, playbooks) in Yardhand's look. Rendered as React elements, never as HTML, so a
 * manual can't run anything in the owner's browser; links open in a new tab.
 */
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/ui/cn'

const COMPONENTS: Components = {
  h1: ({ children }) => <h3 className="mt-6 text-xl font-medium tracking-tight first:mt-0">{children}</h3>,
  h2: ({ children }) => <h4 className="mt-6 text-lg font-medium tracking-tight first:mt-0">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-5 text-base font-medium first:mt-0">{children}</h5>,
  h4: ({ children }) => <h6 className="mt-4 text-sm font-medium first:mt-0">{children}</h6>,
  p: ({ children }) => <p className="mt-3 leading-relaxed text-pretty first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="mt-3 list-disc space-y-1 pl-5 first:mt-0">{children}</ul>,
  ol: ({ children }) => <ol className="mt-3 list-decimal space-y-1 pl-5 first:mt-0">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mt-3 border-l-2 border-primary/40 bg-primary/5 px-4 py-2 text-foreground first:mt-0">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  ),
  code: ({ className, children }) =>
    className ? (
      <code className={cn('font-mono text-[12.5px]', className)}>{children}</code>
    ) : (
      <code className="bg-muted px-1 py-0.5 font-mono text-[12.5px] break-words">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="mt-3 overflow-x-auto border border-border bg-muted/60 p-3 font-mono text-[12.5px] leading-relaxed first:mt-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="mt-3 overflow-x-auto first:mt-0">
      <table className="w-full border border-border text-left text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-border bg-muted px-3 py-2 font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b border-border px-3 py-2 align-top">{children}</td>,
  hr: () => <hr className="my-5 border-border" />,
}

export const Markdown = ({ children, className }: { children: string; className?: string }) => (
  <div className={cn('min-w-0 text-sm text-foreground', className)}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  </div>
)

/** Frontmatter (`---` … `---`) is for machines: the owner reads the rest. */
export const withoutFrontmatter = (text: string) => text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
