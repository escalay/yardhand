/**
 * The pipeline's reads: a manual, a playbook filled in with arguments, or a link an upstream serves. Each meets the
 * same rules as a tool call (the client's allowlist, the upstream switched on) and lands in the same log with its
 * kind. Reads need no write scope.
 *
 * Links are taken as they come: `cookbook://recipes/123` finds its upstream by scheme among those the client may use
 * (or by `upstream` when two share a scheme), `gateway://u/cookbook/<uri>` names it outright, `gateway://u/cookbook/manual`
 * is cookbook's manual, and `skill://<manual>/<file>` is one file of a manual.
 */
import type { Adapters, Credential, PromptResult, ResourceResult } from '../../adapters/index.js'
import { ProblemError } from '../../kit/index.js'
import { type ManualContent, type PlaybookContent, skillPathOf } from '../catalog/content.js'
import { agentFilesOf, noteFor, schemeOf } from '../catalog/manual.js'
import type { CatalogRepo, LiveItem } from '../catalog/repo.js'
import { allows, holds, type Principal } from '../clients/principals.js'
import type { ToolsRepo } from '../tools/repo.js'
import type { UpstreamsRepo } from '../upstreams/repo.js'
import type { UpstreamRow } from '../upstreams/schema.js'
import { endpointOf } from '../upstreams/sync.js'
import type { Handed } from './handed.js'
import type { CallsRepo } from './repo.js'
import type { CallRow } from './schema.js'

const GATEWAY_LINK = /^gateway:\/\/u\/([a-z0-9][a-z0-9-]{0,39})\/(.+)$/

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type ManualRead = {
  id: string
  item: LiveItem
  upstream: UpstreamRow
  note: string
  files: Record<string, string>
}

export const createReads = ({
  catalog,
  tools,
  upstreams,
  adapters,
  calls,
  credentialOf,
  handed,
}: {
  catalog: CatalogRepo
  tools: ToolsRepo
  upstreams: UpstreamsRepo
  adapters: Adapters
  calls: CallsRepo
  credentialOf: (id: string) => Promise<Credential | undefined>
  handed: Handed
}) => {
  type Context = { principal: Principal; via: CallRow['via'] }
  const record = (
    { principal, via }: Context,
    entry: { kind: CallRow['kind']; name: string; upstreamId: string | null; versionId?: string | null },
    outcome: { status: CallRow['status']; error?: string | null; started: number; bytes?: number },
  ) =>
    calls.record({
      clientId: principal.id,
      clientName: principal.name,
      tool: entry.name,
      kind: entry.kind,
      upstreamId: entry.upstreamId,
      versionId: entry.versionId ?? null,
      via,
      status: outcome.status,
      error: outcome.error ?? null,
      durationMs: Date.now() - outcome.started,
      resultBytes: outcome.bytes ?? 0,
    })

  /** The upstream, if this client may read from it now. */
  const reachable = async (principal: Principal, upstreamId: string) => {
    const row = await upstreams.get(upstreamId)
    return row && allows(principal, upstreamId) && (row.enabled || principal.owner) ? row : undefined
  }

  /** How a manual's tools and links are reached through the gateway. */
  const noteOf = async (upstreamId: string, manualText: string) => {
    const own = await tools.listLive({ upstreams: [upstreamId], limit: 2000 })
    // The example is the tool the manual names first, so the note and the manual agree
    const mentioned = own
      .map((tool) => ({
        tool,
        at: manualText.search(new RegExp(`\\b${tool.remoteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)),
      }))
      .filter(({ at }) => at >= 0)
      .sort((a, b) => a.at - b.at)
    const exampleTool = mentioned[0]?.tool ?? own[0]
    const links = await catalog.listLive({ kinds: ['template', 'resource'], upstreams: [upstreamId] })
    const schemes = [
      ...new Set(links.map((link) => schemeOf(link.remoteName)).filter((scheme): scheme is string => Boolean(scheme))),
    ]
    return noteFor({ upstreamId, exampleTool: exampleTool?.remoteName ?? null, linkSchemes: schemes })
  }

  /** A manual's files as agents read them, if this client may read it; nothing is logged. */
  const manualFiles = async (principal: Principal, name: string) => {
    const item = await catalog.live('manual', name)
    const row = item && holds(principal, item) ? await reachable(principal, item.upstreamId) : undefined
    if (!item || !row) return undefined
    const note = await noteOf(item.upstreamId, (item.content as ManualContent).files['SKILL.md'] ?? '')
    return { item, upstream: row, note, files: agentFilesOf(item.content as ManualContent, note) }
  }

  const manual = async (context: Context, name: string): Promise<ManualRead> => {
    const started = Date.now()
    const found = await manualFiles(context.principal, name)
    if (!found) {
      const problem = new ProblemError('not_found', {
        detail: `No manual ${name} for this client. GET /api/manuals (or list_upstreams) lists yours.`,
      })
      await record(
        context,
        { kind: 'manual', name, upstreamId: null },
        { status: 'refused', error: problem.message, started },
      )
      throw problem
    }
    const id = await record(
      context,
      { kind: 'manual', name, upstreamId: found.item.upstreamId, versionId: found.item.versionId },
      { status: 'ok', started, bytes: Object.values(found.files).join('').length },
    )
    return { id, ...found }
  }

  /** Which manual a `skill://…` URI is in, and which of its files: the manual whose skill path is the longest prefix. */
  const skillTarget = async (principal: Principal, uri: string) => {
    if (!uri.startsWith('skill://')) return undefined
    const manuals = await catalog.listLive({ kinds: ['manual'], upstreams: principal.upstreams })
    const matches = manuals
      .filter((item) => holds(principal, item))
      .map((item) => ({ item, root: `skill://${skillPathOf(item.upstreamId, item.content as ManualContent)}/` }))
      .filter(({ root }) => uri.startsWith(root))
      .sort((a, b) => b.root.length - a.root.length)
    const found = matches[0]
    return found ? { name: found.item.name, file: decodeURIComponent(uri.slice(found.root.length)) } : undefined
  }

  /** An upstream's manual: the one named after it, else its first. */
  const manualOfUpstream = async (context: Context, upstreamId: string) => {
    const manuals = (await catalog.listLive({ kinds: ['manual'], upstreams: [upstreamId] })).filter((item) =>
      holds(context.principal, item),
    )
    const chosen = manuals.find((item) => item.name === upstreamId) ?? manuals[0]
    if (!chosen)
      throw new ProblemError('not_found', {
        detail: `${upstreamId} has no manual. Its instructions are in list_upstreams (GET /api/upstreams/${upstreamId}).`,
      })
    return manual(context, chosen.name)
  }

  const playbook = async (
    context: Context,
    name: string,
    args: Record<string, string>,
  ): Promise<{ id: string; item: LiveItem; result: PromptResult }> => {
    const started = Date.now()
    const item = await catalog.live('playbook', name)
    const row = item && holds(context.principal, item) ? await reachable(context.principal, item.upstreamId) : undefined
    const refuse = async (problem: ProblemError) => {
      await record(
        context,
        { kind: 'playbook', name, upstreamId: item?.upstreamId ?? null },
        { status: 'refused', error: problem.message, started },
      )
      throw problem
    }
    if (!item || !row || !(row.playbooks || context.principal.owner || context.principal.pack))
      return refuse(
        new ProblemError('not_found', {
          detail: `No playbook ${name} for this client. GET /api/playbooks?q=<what you want to do> finds yours.`,
        }),
      )
    if (!row.enabled) return refuse(new ProblemError('unavailable', { detail: `Upstream ${row.id} is switched off.` }))
    const content = item.content as PlaybookContent
    const missing = content.arguments.filter((arg) => arg.required && !args[arg.name]?.trim()).map((arg) => arg.name)
    if (missing.length)
      return refuse(
        new ProblemError('bad_request', {
          detail: `${name} needs ${missing.join(', ')}: ${content.arguments.map((arg) => `${arg.name}${arg.description ? ` (${arg.description})` : ''}`).join('; ')}.`,
        }),
      )
    try {
      const result = await adapters
        .for(row.kind)
        .getPrompt(endpointOf(row), await credentialOf(row.id), content.prompt, args)
      const id = await record(
        context,
        { kind: 'playbook', name, upstreamId: row.id, versionId: item.versionId },
        { status: 'ok', started, bytes: JSON.stringify(result).length },
      )
      await calls.keepPayload(id, { arguments: args, result })
      return { id, item, result }
    } catch (error) {
      await record(
        context,
        { kind: 'playbook', name, upstreamId: row.id, versionId: item.versionId },
        { status: 'failed', error: message(error).slice(0, 1000), started },
      )
      throw error instanceof ProblemError
        ? error
        : new ProblemError('upstream', { detail: `${row.id}: ${message(error)}` })
    }
  }

  /** Which upstream serves a link: named, or found by its scheme among those this client may use. */
  const upstreamOfLink = async (principal: Principal, uri: string, named: string | undefined) => {
    if (named) return named
    const scheme = schemeOf(uri)
    if (!scheme)
      throw new ProblemError('bad_request', {
        detail: `${uri} names no upstream. Pass upstream (an id from list_upstreams), or use gateway://u/<upstream>/<uri>.`,
      })
    const links = await catalog.listLive({ kinds: ['template', 'resource'], upstreams: principal.upstreams })
    const serving = [
      ...new Set(links.filter((link) => schemeOf(link.remoteName) === scheme).map((link) => link.upstreamId)),
    ]
    const [only] = serving
    if (only && serving.length === 1) return only
    throw new ProblemError(serving.length ? 'bad_request' : 'not_found', {
      detail: serving.length
        ? `${serving.join(' and ')} both serve ${scheme}:// links: pass upstream to say which.`
        : `No upstream you may use serves ${scheme}:// links. GET /api/links lists the links each serves.`,
    })
  }

  const link = async (
    context: Context,
    uri: string,
    named?: string,
  ): Promise<{ id: string; upstream: string; result: ResourceResult }> => {
    const match = GATEWAY_LINK.exec(uri)
    const gateway = match?.[1] && match[2] ? { upstream: match[1], uri: match[2] } : null
    if (gateway?.uri === 'manual') return asResource(await manualOfUpstream(context, gateway.upstream), uri)
    const skill = named ? undefined : await skillTarget(context.principal, uri)
    if (skill) {
      const read = await manual(context, skill.name)
      const text = read.files[skill.file]
      if (text === undefined)
        throw new ProblemError('not_found', {
          detail: `${read.item.name}'s manual has no ${skill.file}. Its files: ${Object.keys(read.files).join(', ')}.`,
        })
      return {
        id: read.id,
        upstream: read.item.upstreamId,
        result: { contents: [{ uri, mimeType: 'text/markdown', text }] },
      }
    }
    const started = Date.now()
    const target = gateway ? gateway.uri : uri
    let upstreamId: string
    try {
      upstreamId = gateway ? gateway.upstream : await upstreamOfLink(context.principal, target, named)
    } catch (problem) {
      await record(
        context,
        { kind: 'link', name: uri, upstreamId: null },
        { status: 'refused', error: message(problem), started },
      )
      throw problem
    }
    const row = await reachable(context.principal, upstreamId)
    if (!row?.enabled) {
      const problem = new ProblemError('not_found', {
        detail: `No upstream ${upstreamId} for this client. list_upstreams (GET /api/upstreams) lists yours.`,
      })
      await record(
        context,
        { kind: 'link', name: target, upstreamId: null },
        { status: 'refused', error: problem.message, started },
      )
      throw problem
    }
    if (!(await handed.readsLink(context.principal, row.id, target))) {
      const problem = new ProblemError('forbidden', {
        detail: `${target} was not in a result of ${context.principal.pack?.title ?? 'the pack'}'s tools in the last day: a key locked to a pack reads only the links its tools returned.`,
      })
      await record(
        context,
        { kind: 'link', name: target, upstreamId: row.id },
        { status: 'refused', error: problem.message, started },
      )
      throw problem
    }
    try {
      const result = await adapters.for(row.kind).readResource(endpointOf(row), await credentialOf(row.id), target)
      const id = await record(
        context,
        { kind: 'link', name: target, upstreamId: row.id },
        { status: 'ok', started, bytes: JSON.stringify(result).length },
      )
      await calls.keepPayload(id, { arguments: { uri: target }, result })
      // What a link holds may link onwards
      await handed.note(context.principal, row.id, result, undefined)
      return { id, upstream: row.id, result }
    } catch (error) {
      await record(
        context,
        { kind: 'link', name: target, upstreamId: row.id },
        { status: 'failed', error: message(error).slice(0, 1000), started },
      )
      throw error instanceof ProblemError
        ? error
        : new ProblemError('upstream', { detail: `${row.id}: ${message(error)}` })
    }
  }

  const asResource = (read: ManualRead, uri: string) => ({
    id: read.id,
    upstream: read.item.upstreamId,
    result: { contents: [{ uri, mimeType: 'text/markdown', text: read.files['SKILL.md'] ?? '' }] },
  })

  return { manual, manualFiles, manualOfUpstream, skillTarget, playbook, link }
}

export type Reads = ReturnType<typeof createReads>
