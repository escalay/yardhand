/**
 * `/u/{upstream}/mcp`: one upstream's own MCP endpoint (its resources, prompts and instructions intact) behind the
 * gateway's credentials and allowlist. A read-only client can't call tools that change things through it either.
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { allows, callerOf } from '../features/clients/principals.js'
import { isOff, needsWrite } from '../features/tools/repo.js'
import { toolNameOf } from '../features/upstreams/sync.js'
import { ProblemError, problemResponse } from '../kit/index.js'
import type { Services } from '../services.js'

const FORWARD_IN = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'mcp-method', 'last-event-id']
const FORWARD_OUT = ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control']

type Message = { jsonrpc?: string; id?: string | number; method?: string; params?: { name?: string } }

export const mountPassthrough = (
  app: OpenAPIHono,
  { principals, upstreams, tools, upstreamHeaders, calls }: Services,
) => {
  app.all('/u/:upstream/mcp', async (c: Context) => {
    const principal = await principals.require(callerOf(c)).catch((problem: ProblemError) => problem)
    if (principal instanceof ProblemError) return problemResponse(c, 'forbidden', { detail: principal.message })
    // A passthrough serves the whole upstream, so a key locked to a pack never gets one
    if (principal.pack)
      return problemResponse(c, 'forbidden', {
        detail: `This key is locked to the pack ${principal.pack.title}: connect to /mcp, which serves just the pack.`,
      })
    const id = c.req.param('upstream') ?? ''
    const upstream = await upstreams.get(id)
    if (!upstream?.enabled || !allows(principal, id))
      return problemResponse(c, 'not_found', {
        detail: `No upstream ${id} for this client. GET /api/upstreams lists yours.`,
      })
    // Its lists come as the server writes them, unreviewed: only for a server whose changes go live by themselves
    if (upstream.trust !== 'trusted')
      return problemResponse(c, 'forbidden', {
        detail: `${id}'s changes wait for the owner's review, so it has no passthrough: use its tools through /mcp or /api/calls.`,
      })
    if (upstream.kind !== 'mcp')
      return problemResponse(c, 'bad_request', {
        detail: `${id} is a REST upstream: use its tools through /mcp or /api/calls.`,
      })

    const body = ['GET', 'HEAD', 'DELETE'].includes(c.req.method) ? undefined : await c.req.text()
    const parsed = body
      ? (() => {
          try {
            return JSON.parse(body) as Message | Message[]
          } catch {
            return null
          }
        })()
      : null
    const toolCalls = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).filter(
      (message) => message.method === 'tools/call',
    )
    for (const message of toolCalls) {
      const name = toolNameOf(id, message.params?.name ?? '')
      const tool = await tools.live(name)
      const off = tool ? isOff(tool) : false
      if (!tool || off || (principal.scope === 'read' && needsWrite(tool))) {
        await calls.record({
          clientId: principal.id,
          clientName: principal.name,
          tool: name,
          upstreamId: id,
          versionId: tool?.versionId ?? null,
          via: 'passthrough',
          status: 'refused',
          error: !tool ? 'not a live tool' : off ? 'switched off' : 'read-only client',
          durationMs: 0,
          resultBytes: 0,
        })
        return c.json({
          jsonrpc: '2.0',
          id: message.id ?? null,
          error: {
            code: -32001,
            message: !tool
              ? `${name} is not a tool the gateway serves (new tools appear after its next sync).`
              : off
                ? `${name} is switched off by the owner.`
                : `${name} changes things, and this client is read-only.`,
          },
        })
      }
    }

    const headers: Record<string, string> = { ...(await upstreamHeaders(upstream)) }
    for (const name of FORWARD_IN) {
      const value = c.req.header(name)
      if (value) headers[name] = value
    }
    const started = Date.now()
    const response = await fetch(upstream.url, {
      method: c.req.method,
      headers,
      ...(body === undefined ? {} : { body }),
    }).catch(() => null)
    for (const message of toolCalls)
      await calls.record({
        clientId: principal.id,
        clientName: principal.name,
        tool: toolNameOf(id, message.params?.name ?? ''),
        upstreamId: id,
        versionId: null,
        via: 'passthrough',
        status: response?.ok ? 'ok' : 'failed',
        error: response?.ok ? null : `HTTP ${response?.status ?? 'unreachable'}`,
        durationMs: Date.now() - started,
        resultBytes: 0,
      })
    if (!response) return problemResponse(c, 'upstream', { detail: `${id} did not answer.` })
    const out = new Headers()
    for (const name of FORWARD_OUT) {
      const value = response.headers.get(name)
      if (value) out.set(name, value)
    }
    return new Response(response.body, { status: response.status, headers: out })
  })
}
