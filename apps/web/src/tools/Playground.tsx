/**
 * Trying a tool: a form built from its input schema (or raw JSON), run through the same pipeline agents use, the
 * answer as an agent gets it, and the same call ready to copy as curl, TypeScript or an MCP call. Tools that change
 * things ask once before running for real.
 */
import { IconBraces, IconForms, IconPlayerPlay } from '@tabler/icons-react'
import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { api, type ToolDetail, unwrap } from '@/api/client'
import { Code } from '@/ui/Code'
import { Field } from '@/ui/Field'
import { duration } from '@/ui/format'
import { Status } from '@/ui/Status'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/shadcn/alert-dialog'
import { Button } from '@/ui/shadcn/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/shadcn/tabs'
import { Textarea } from '@/ui/shadcn/textarea'
import { FieldControl } from './FieldControl'
import { type Answers, Questions } from './Questions'
import { argumentsOf, type FormField, fieldsOf, valuesOf } from './schema-form.rules'

type Block = { type: string; text?: string; data?: string; mimeType?: string; uri?: string; name?: string }

const BlockView = ({ block }: { block: Block }) =>
  block.type === 'text' ? (
    <Code copy>{block.text ?? ''}</Code>
  ) : block.type === 'image' && block.data ? (
    <img
      src={`data:${block.mimeType};base64,${block.data}`}
      alt=""
      className="max-h-96 border border-border object-contain"
    />
  ) : block.type === 'resource_link' ? (
    <a href={block.uri} target="_blank" rel="noreferrer" className="font-mono text-sm underline underline-offset-4">
      {block.name ?? block.uri}
    </a>
  ) : (
    <Code>{JSON.stringify(block, null, 2)}</Code>
  )

const Answer = ({ blocks, structured }: { blocks: Block[]; structured: unknown }) => (
  <div className="flex flex-col gap-3">
    {blocks.map((block, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: an answer's blocks have no identity beyond their place
      <BlockView key={index} block={block} />
    ))}
    {!blocks.length && structured !== undefined ? <Code copy>{JSON.stringify(structured, null, 2)}</Code> : null}
  </div>
)

export const Playground = ({ tool, initialArgs }: { tool: ToolDetail; initialArgs?: Record<string, unknown> }) => {
  const fields = useMemo(() => fieldsOf(tool.inputSchema), [tool.inputSchema])
  const [values, setValues] = useState<Record<string, string>>(() => valuesOf(fields, initialArgs ?? {}))
  const [raw, setRaw] = useState<string | null>(fields.length ? null : JSON.stringify(initialArgs ?? {}, null, 2))
  const [confirming, setConfirming] = useState(false)
  const required = fields.filter((field) => field.required)
  const optional = fields.filter((field) => !field.required)
  // Optional fields open when there is nothing required, or when a past call filled one in
  const [showOptional, setShowOptional] = useState(
    () => !required.length || optional.some((field) => initialArgs?.[field.name] !== undefined),
  )
  const read = () => {
    if (raw === null) return argumentsOf(fields, values)
    try {
      return { args: JSON.parse(raw || '{}') as Record<string, unknown>, errors: {} as Record<string, string> }
    } catch {
      return { args: {}, errors: { _json: 'Not valid JSON.' } as Record<string, string> }
    }
  }
  const { args, errors } = read()
  const fieldOf = (field: FormField) => (
    <Field
      key={field.name}
      label={
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-[13px]">{field.name}</span>
          {field.required ? <span className="text-xs text-error">required</span> : null}
          {field.hint ? <span className="text-xs font-normal text-faint-foreground">{field.hint}</span> : null}
        </span>
      }
      hint={field.description}
      error={run.isIdle ? null : (errors[field.name] ?? null)}
    >
      {(id) => (
        <FieldControl
          field={field}
          id={id}
          value={values[field.name] ?? ''}
          onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
        />
      )}
    </Field>
  )
  // The owner answers questions the server asks mid-call here, as an agent's client would
  const run = useMutation({
    mutationFn: (answers?: Answers) =>
      unwrap(
        api.POST('/api/calls', {
          body: { tool: tool.name, arguments: args, interactive: true, ...(answers ? { answers } : {}) },
        }),
      ),
  })
  const off = tool.access === 'off'
  const ready = !Object.keys(errors).length && !off
  const go = () => (tool.needsWrite ? setConfirming(true) : run.mutate(undefined))
  const origin = location.origin
  const body = JSON.stringify(args)
  const snippets = {
    curl: `curl -s ${origin}/api/tools/${tool.name}/calls \\\n  -H "Authorization: Bearer $YARDHAND_KEY" \\\n  -H 'content-type: application/json' \\\n  -d '${body.replaceAll("'", "'\\''")}'`,
    typescript: `import { createGateway, textOf } from '@yardhand/client'\n\nconst gateway = createGateway({ url: '${origin}', key: process.env.YARDHAND_KEY! })\nconst result = await gateway.call('${tool.name}', ${JSON.stringify(args, null, 2)})\nconsole.log(textOf(result))`,
    mcp: `call_tool({\n  name: "${tool.name}",\n  arguments: ${JSON.stringify(args, null, 2).replaceAll('\n', '\n  ')}\n})`,
  }
  const result = run.data

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-4 border border-border bg-card p-5"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready) go()
        }}
      >
        <div className="flex items-center justify-between">
          <span className="text-xs tracking-wide text-muted-foreground uppercase">Try it</span>
          {fields.length ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setRaw(raw === null ? JSON.stringify(args, null, 2) : null)}
            >
              {raw === null ? <IconBraces /> : <IconForms />} {raw === null ? 'Edit as JSON' : 'Back to the form'}
            </Button>
          ) : null}
        </div>
        {raw !== null ? (
          <Field label="Arguments" hint="JSON, as the input schema describes." error={errors._json ?? null}>
            {(id) => (
              <Textarea
                id={id}
                value={raw}
                onChange={(event) => setRaw(event.target.value)}
                rows={8}
                className="font-mono text-[12.5px]"
              />
            )}
          </Field>
        ) : (
          <>
            {required.map(fieldOf)}
            {optional.length ? (
              <details
                open={showOptional}
                onToggle={(event) => setShowOptional(event.currentTarget.open)}
                className="flex flex-col gap-4"
              >
                <summary className="cursor-pointer text-sm text-muted-foreground select-none hover:text-foreground">
                  {showOptional ? 'Fewer options' : `More options · ${optional.length}`}
                </summary>
                <div className="mt-4 flex flex-col gap-4">{optional.map(fieldOf)}</div>
              </details>
            ) : null}
          </>
        )}
        {!fields.length && raw === null ? (
          <p className="text-sm text-muted-foreground">It takes no arguments.</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={!ready || run.isPending}>
            <IconPlayerPlay /> {run.isPending ? 'Running…' : 'Run'}
          </Button>
          {off ? (
            <span className="text-sm text-muted-foreground">Switched off: turn it back on to run it.</span>
          ) : tool.needsWrite ? (
            <span className="text-sm text-muted-foreground">This changes something for real.</span>
          ) : null}
        </div>
      </form>

      {run.error ? (
        <div className="flex flex-col gap-1 border border-error/30 bg-error-soft p-5">
          <Status tone="error">It didn't run</Status>
          <p className="text-sm text-pretty">{run.error.message}</p>
        </div>
      ) : null}
      {result?.status === 'asked' && result.asked ? (
        <Questions asked={result.asked} busy={run.isPending} onAnswer={(answers) => run.mutate(answers)} />
      ) : result ? (
        <div className="flex flex-col gap-3 border border-border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Status tone={result.status === 'ok' ? 'ok' : 'warn'}>
              {result.status === 'ok' ? 'It answered' : 'The tool said no'}
            </Status>
            <span className="text-sm text-muted-foreground">
              {duration(result.durationMs)} ·{' '}
              <Link
                to="/activity"
                search={{ outcome: 'all', call: result.id }}
                className="underline underline-offset-4"
              >
                in Activity
              </Link>
            </span>
          </div>
          <Answer blocks={result.result.content as Block[]} structured={result.result.structuredContent} />
        </div>
      ) : null}

      <Tabs defaultValue="curl" className="border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs tracking-wide text-muted-foreground uppercase">The same call from</span>
          <TabsList>
            <TabsTrigger value="curl">curl</TabsTrigger>
            <TabsTrigger value="typescript">TypeScript</TabsTrigger>
            <TabsTrigger value="mcp">MCP</TabsTrigger>
          </TabsList>
        </div>
        {Object.entries(snippets).map(([id, text]) => (
          <TabsContent key={id} value={id} className="mt-3">
            <Code copy>{text}</Code>
          </TabsContent>
        ))}
      </Tabs>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run {tool.name} for real?</AlertDialogTitle>
            <AlertDialogDescription>
              It changes something on {tool.upstream}, exactly as it would for an agent. There is no undo from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Code>{JSON.stringify(args, null, 2)}</Code>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction variant="primary" onClick={() => run.mutate(undefined)}>
              Run it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
