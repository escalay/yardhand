/**
 * Build handlers (owner only, never at a pack's address). A proposal is accepted once, onto the pack as it was when
 * the build started, through the pack's own checks; the build is marked accepted before anything is written, so two
 * accepts at once never both apply.
 */
import type { RouteHandler } from '@hono/zod-openapi'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { requireOwner } from '../clients/principals.js'
import { judge, throwOnRefused } from '../packs/checks.js'
import { packsHandlers } from '../packs/handlers.js'
import { noPack } from '../packs/names.js'
import type { PackRow } from '../packs/schema.js'
import { packStateOf } from '../packs/state.js'
import type { Proposal } from './builder.js'
import { draftOf } from './drafts.js'
import { applyLines, missingNeeds, touchedOf, write } from './proposal.js'
import { triedOf } from './rehearsal.js'
import { pathOf, type routes } from './routes.js'
import { BUILD_CAP_USD, estimateOf, REHEARSAL_STEPS, TOKEN_BUDGET } from './spend.js'

type Routes = typeof routes

const UNKNOWN_COST = `Cost not known for this provider: the build is held to ${TOKEN_BUDGET.toLocaleString('en-US')} tokens instead.`
const INTERRUPTED = 'Interrupted: the gateway restarted while it ran. Build again.'

export const buildsHandlers = (services: Services) => {
  const { packs, tools, catalog, upstreams, builds, builder, model, listsChanged } = services
  const repos = { packs, tools, catalog, upstreams }
  const { detailOf } = packsHandlers(services)
  const packOf = async (name: string) => {
    const pack = await packs.get(name)
    if (!pack) throw new ProblemError('not_found', { detail: await noPack(packs, name) })
    return pack
  }
  const buildOf = async (pack: PackRow, id: string) => {
    const row = await builds.get(pack.id, id)
    if (!row)
      throw new ProblemError('not_found', {
        detail: `${pack.title} has no build ${id}. GET ${pathOf(pack.name).replace(/\/builds$/, '')} names its newest under \`build\`.`,
      })
    return row
  }
  const ready = async () => {
    if (await model.ready()) return
    throw new ProblemError('conflict', {
      detail:
        (await services.ai.builds()).connection === 'own'
          ? 'Build with AI has a provider, address or key of its own, so it uses none of smart grouping’s, and it can’t reach a model yet: give it a key (and an address for local or custom) in Settings › AI (PATCH /api/ai/builds), or clear all three to use smart grouping’s.'
          : 'Build with AI has no model to ask: give it a key in Settings › AI (PATCH /api/ai/builds), or give smart grouping one, which it follows.',
    })
  }

  /** A build as answered: a `running` row this process doesn't hold was cut off by a restart. */
  const viewOf = (origin: string, pack: PackRow, row: NonNullable<Awaited<ReturnType<typeof builds.get>>>) => {
    const live = row.status === 'running' && builder.holds(pack.id, row.id) ? builder.runningIn(pack.id) : undefined
    const cut = row.status === 'running' && !live
    const spent = live ? live.spent() : row.spent
    const proposal = row.proposal as Proposal | null
    return {
      id: row.id,
      pack: pack.name,
      mode: row.mode,
      status: cut ? ('failed' as const) : row.status,
      step: live?.step ?? null,
      tasks: row.tasks,
      estimate: row.estimate,
      spent,
      costNote: spent.known || !spent.modelCalls ? null : UNKNOWN_COST,
      stopped: row.stopped,
      notDone: row.notDone,
      error: cut ? INTERRUPTED : row.error,
      proposal: proposal
        ? {
            model: proposal.model,
            // A proposal made before 0.6.1 has no `includeChanges`, and may have ticked taking a tool out
            lines:
              proposal.includeChanges === undefined
                ? proposal.lines.map((line) =>
                    line.kind === 'tool' && line.change === 'remove' ? { ...line, suggested: false } : line,
                  )
                : proposal.lines,
            skipped: proposal.skipped,
            // A proposal made before 0.6.1 has no `tried`
            rehearsal: proposal.rehearsal.map((entry) => ({ ...entry, tried: entry.tried ?? triedOf(entry.steps) })),
            findings: proposal.findings,
            includeChanges: proposal.includeChanges ?? false,
          }
        : null,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      _links: linksOf(origin, {
        self: pathOf(pack.name, row.id),
        pack: `/api/packs/${pack.name}`,
        ...(row.status === 'ready' || row.status === 'stopped'
          ? { accept: `${pathOf(pack.name, row.id)}/accept` }
          : {}),
      }),
    }
  }

  const estimateFor = async (tasks: string[]) => {
    const price = await model.price()
    return { price, ...estimateOf({ tasks, price }) }
  }

  const estimate: RouteHandler<Routes['estimate']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    const { mode, tasks, includeChanges } = c.req.valid('json')
    await ready()
    const figure = await estimateFor(tasks)
    return c.json(
      {
        mode,
        includeChanges: includeChanges ?? false,
        usd: figure.usd === null ? null : Math.round(figure.usd * 10_000) / 10_000,
        capUsd: BUILD_CAP_USD,
        priceKnown: figure.price !== null,
        note: figure.price ? null : UNKNOWN_COST,
        modelCalls: figure.modelCalls,
        tokens: figure.tokens,
        model: await model.name(),
        realCalls: REHEARSAL_STEPS * tasks.length,
        _links: linksOf(originOf(c), { self: `${pathOf(pack.name)}/estimate`, start: pathOf(pack.name) }),
      },
      200,
    )
  }

  const start: RouteHandler<Routes['start']> = async (c) => {
    requireOwner(c)
    const pack = await packOf(c.req.valid('param').name)
    const { mode, tasks, includeChanges } = c.req.valid('json')
    await ready()
    const figure = await estimateFor(tasks)
    if (figure.usd !== null && figure.usd > BUILD_CAP_USD)
      throw new ProblemError('spend_cap', {
        detail: `This build is estimated at $${figure.usd.toFixed(2)}, over the $${BUILD_CAP_USD.toFixed(2)} a build may spend: give fewer example tasks.`,
      })
    const started = await builder.start(pack, {
      mode,
      tasks,
      includeChanges: includeChanges ?? false,
      estimate: { usd: figure.usd, tokens: figure.tokens, modelCalls: figure.modelCalls },
    })
    if ('busy' in started)
      throw new ProblemError('conflict', {
        detail: `A build is already running for ${pack.title}: wait for it (GET ${pathOf(pack.name, started.busy)}), then build again.`,
      })
    const row = await buildOf(pack, started.id)
    return c.json(viewOf(originOf(c), pack, row), 202, { location: pathOf(pack.name, started.id) })
  }

  const get: RouteHandler<Routes['get']> = async (c) => {
    requireOwner(c)
    const { name, id } = c.req.valid('param')
    const pack = await packOf(name)
    return c.json(viewOf(originOf(c), pack, await buildOf(pack, id)), 200)
  }

  /** Why a build's proposal can't be accepted or discarded now; null when it can. */
  const settledWhy = (status: string) =>
    status === 'accepted'
      ? 'This proposal was already accepted: build again for a new one.'
      : status === 'discarded'
        ? 'This proposal was discarded: build again for a new one.'
        : status === 'running'
          ? 'This build is still running: wait for its proposal.'
          : status === 'failed'
            ? 'This build failed, so it has no proposal: build again.'
            : null

  const accept: RouteHandler<Routes['accept']> = async (c) => {
    requireOwner(c)
    const { name, id } = c.req.valid('param')
    const pack = await packOf(name)
    const row = await buildOf(pack, id)
    const proposal = row.proposal as Proposal | null
    const why = settledWhy(viewOf(originOf(c), pack, row).status)
    if (why || !proposal)
      throw new ProblemError('conflict', { detail: why ?? 'This build has no proposal: build again.' })
    if (pack.updatedAt !== row.packUpdatedAt)
      throw new ProblemError('conflict', {
        detail: `${pack.title} changed since this proposal was made: discard it and build again.`,
      })
    const wanted = new Set(c.req.valid('json').lines)
    const unknown = [...wanted].filter((line) => !proposal.lines.some((entry) => entry.id === line))
    if (unknown.length)
      throw new ProblemError('bad_request', {
        detail: `No line ${unknown.join(', ')} in this proposal: GET ${pathOf(pack.name, id)} lists its lines.`,
      })
    const missing = missingNeeds(proposal.lines, [...wanted])
    if (missing.length)
      throw new ProblemError('bad_request', {
        detail: missing
          .map((entry) => `Accepting ${entry.line} needs ${entry.needs.join(' and ')}: tick both.`)
          .join(' '),
      })
    const chosen = proposal.lines.filter((line) => wanted.has(line.id))
    const contents = await packs.contentsOf(pack)
    const before = draftOf(await packStateOf(repos, pack, contents), contents)
    // The tools as they are live now, not as they were when drafted
    const live = new Map(
      (await tools.liveMany(proposal.after.tools.map((tool) => tool.tool))).map((tool) => [tool.name, tool]),
    )
    const after = {
      ...proposal.after,
      tools: proposal.after.tools.map((tool) => ({ ...tool, live: live.get(tool.tool) ?? null })),
    }
    // As adding a tool by hand: a tool that left since the build can't come in, nor can its wording or inputs
    const gone = [
      ...new Set(
        chosen.flatMap((line) => {
          const target = line.kind === 'input' ? line.target.slice(0, line.target.lastIndexOf('.')) : line.target
          const tool = after.tools.find((entry) => entry.name === target)
          const added = !before.tools.some((entry) => entry.name === target)
          return (line.kind === 'tool' && line.change !== 'remove') ||
            ((line.kind === 'wording' || line.kind === 'input') && added)
            ? tool && !tool.live
              ? [tool.tool]
              : []
            : []
        }),
      ),
    ]
    if (gone.length)
      throw new ProblemError('bad_request', {
        detail: `Not live, so not added: ${gone.join(', ')}. Untick its lines, or sync its connection and build again.`,
      })
    const applied = applyLines(before, after, chosen)
    throwOnRefused(judge(before, applied, touchedOf(chosen)).refused)
    if (!(await builds.settle(pack.id, id, ['ready', 'stopped'], 'accepted')))
      throw new ProblemError('conflict', { detail: 'This proposal was already accepted: build again for a new one.' })
    await write({ packs }, pack, before, applied)
    listsChanged()
    return c.json(await detailOf(originOf(c), await packOf(pack.name)), 200)
  }

  const discard: RouteHandler<Routes['discard']> = async (c) => {
    requireOwner(c)
    const { name, id } = c.req.valid('param')
    const pack = await packOf(name)
    const row = await buildOf(pack, id)
    const status = viewOf(originOf(c), pack, row).status
    if (status === 'running' || status === 'accepted' || status === 'discarded')
      throw new ProblemError('conflict', { detail: settledWhy(status) ?? 'This build can’t be discarded now.' })
    if (!(await builds.settle(pack.id, id, ['ready', 'stopped', 'failed', 'running'], 'discarded')))
      throw new ProblemError('conflict', { detail: 'This proposal was already accepted or discarded.' })
    return c.body(null, 204)
  }

  return { estimate, start, get, accept, discard }
}
