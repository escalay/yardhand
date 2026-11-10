/**
 * A server asking something mid-call, in the playground: each question as a form from its schema (or a link to open),
 * answered or declined by the owner, exactly as an agent's client would. A request for the caller's model can't be
 * answered from the browser, so it says so.
 */
import { useState } from 'react'
import { Field } from '@/ui/Field'
import { Status } from '@/ui/Status'
import { Button } from '@/ui/shadcn/button'
import { Input } from '@/ui/shadcn/input'
import { Switch } from '@/ui/shadcn/switch'
import { argumentsOf, fieldsOf } from './schema-form.rules'

type InputRequest = {
  method?: string
  params?: { message?: string; mode?: string; url?: string; requestedSchema?: Record<string, unknown> }
}

export type Answers = { inputResponses: Record<string, unknown>; requestState: string }

export const Questions = ({
  asked,
  busy,
  onAnswer,
}: {
  asked: { inputRequests: Record<string, unknown>; requestState: string }
  busy: boolean
  onAnswer: (answers: Answers) => void
}) => {
  const entries = Object.entries(asked.inputRequests) as [string, InputRequest][]
  const [values, setValues] = useState<Record<string, Record<string, string>>>({})
  const lendsModel = entries.some(([, request]) => request.method === 'sampling/createMessage')
  const answer = (action: 'accept' | 'decline') => {
    const inputResponses: Record<string, unknown> = {}
    for (const [key, request] of entries) {
      if (request.method === 'roots/list') inputResponses[key] = { roots: [] }
      else if (action === 'decline' || request.params?.mode === 'url') inputResponses[key] = { action }
      else {
        const fields = fieldsOf(request.params?.requestedSchema ?? {})
        inputResponses[key] = { action, content: argumentsOf(fields, values[key] ?? {}).args }
      }
    }
    onAnswer({ inputResponses, requestState: asked.requestState })
  }
  return (
    <div className="flex flex-col gap-4 border border-primary/30 bg-primary/5 p-5">
      <Status tone="neutral">The server asks before going on</Status>
      {entries.map(([key, request]) =>
        request.method === 'elicitation/create' ? (
          <div key={key} className="flex flex-col gap-3">
            <p className="text-sm font-medium text-pretty">{request.params?.message}</p>
            {request.params?.mode === 'url' ? (
              <a
                href={request.params.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm break-all text-primary underline underline-offset-2"
              >
                {request.params.url}
              </a>
            ) : (
              fieldsOf(request.params?.requestedSchema ?? {}).map((field) => (
                <Field key={field.name} label={field.name} hint={field.description}>
                  {(id) =>
                    field.kind === 'boolean' ? (
                      <Switch
                        id={id}
                        checked={values[key]?.[field.name] === 'true'}
                        onCheckedChange={(on) =>
                          setValues((now) => ({ ...now, [key]: { ...now[key], [field.name]: String(on) } }))
                        }
                      />
                    ) : (
                      <Input
                        id={id}
                        value={values[key]?.[field.name] ?? ''}
                        onChange={(event) =>
                          setValues((now) => ({ ...now, [key]: { ...now[key], [field.name]: event.target.value } }))
                        }
                      />
                    )
                  }
                </Field>
              ))
            )}
          </div>
        ) : (
          <p key={key} className="text-sm text-pretty text-muted-foreground">
            {request.method === 'sampling/createMessage'
              ? 'It wants to use the caller’s model. The browser has none to lend: agents whose client supports it can answer this.'
              : `It asks for ${request.method ?? 'something'}.`}
          </p>
        ),
      )}
      <div className="flex gap-2">
        {lendsModel ? null : (
          <Button size="sm" disabled={busy} onClick={() => answer('accept')}>
            Answer
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => answer('decline')}>
          Decline
        </Button>
      </div>
    </div>
  )
}
