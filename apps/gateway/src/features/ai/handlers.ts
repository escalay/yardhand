/** AI handlers (owner only). A key goes into the vault and never comes back out: only whether it is set. */
import type { RouteHandler } from '@hono/zod-openapi'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { requireOwner } from '../clients/principals.js'
import { AiError, listModels, testBuilds, testGrouping, testSearch } from './clients.js'
import { type AiJob, applyChange, ENV_NAMES, type Field, PROVIDERS } from './config.js'
import type { routes } from './routes.js'

type Routes = typeof routes

const withEnv = <T>(field: Field<T>, env: string | null) => ({ ...field, env })

export const aiHandlers = ({ ai, vault }: Services) => {
  const view = async (origin: string) => {
    const [search, grouping, builds] = await Promise.all([ai.search(), ai.grouping(), ai.builds()])
    const names = ENV_NAMES.grouping
    const buildNames = ENV_NAMES.builds
    return {
      jobs: [
        {
          job: 'search' as const,
          title: 'Search by meaning',
          does: 'Finds tools by what they do, not just their names, for agents and in this app.',
          ready: search.ready,
          provider: withEnv(search.provider, null),
          baseUrl: withEnv(search.baseUrl, null),
          key: { set: Boolean(search.key.value), from: search.key.from, env: ENV_NAMES.search.key },
          model: withEnv(search.model, null),
          writerModel: null,
          deciderModel: null,
          deciderProtocol: null,
        },
        {
          job: 'grouping' as const,
          title: 'Smart grouping',
          does: 'Groups each connection’s tools so you can switch parts of it on and off: one model names the groups, another files each tool.',
          ready: grouping.ready,
          provider: withEnv(grouping.provider, names.provider),
          baseUrl: withEnv(grouping.baseUrl, names.baseUrl),
          key: { set: Boolean(grouping.key.value), from: grouping.key.from, env: names.key },
          model: null,
          writerModel: withEnv(grouping.writerModel, names.writerModel),
          deciderModel: withEnv(grouping.deciderModel, names.deciderModel),
          deciderProtocol: withEnv(grouping.deciderProtocol, names.deciderProtocol),
        },
        {
          job: 'builds' as const,
          title: 'Build with AI',
          does: 'Drafts a pack’s tools, wording, playbooks and skill from its purpose and a few example tasks, and tries each task first. With no provider, address or key set here, it uses smart grouping’s; with any, all three are its own. A model left unset is smart grouping’s writer.',
          ready: builds.ready,
          provider: withEnv(builds.provider, buildNames.provider),
          baseUrl: withEnv(builds.baseUrl, buildNames.baseUrl),
          key: { set: Boolean(builds.key.value), from: builds.key.from, env: buildNames.key },
          model: null,
          writerModel: withEnv(builds.writerModel, buildNames.writerModel),
          deciderModel: null,
          deciderProtocol: null,
        },
      ],
      providers: Object.entries(PROVIDERS).map(([id, provider]) => ({
        id: id as keyof typeof PROVIDERS,
        title: provider.title,
        baseUrl: provider.baseUrl,
      })),
      _links: linksOf(origin, { self: '/api/ai', models: '/api/ai/models' }),
    }
  }

  const get: RouteHandler<Routes['get']> = async (c) => {
    requireOwner(c)
    return c.json(await view(originOf(c)), 200)
  }

  const update: RouteHandler<Routes['update']> = async (c) => {
    requireOwner(c)
    const { job } = c.req.valid('param')
    const change = c.req.valid('json')
    if (job === 'search' && Object.keys(change).some((field) => field !== 'key'))
      throw new ProblemError('bad_request', {
        detail: 'Search by meaning takes only a key here: its model is set by agent-api-kit.',
      })
    if (job === 'builds' && (change.deciderModel !== undefined || change.deciderProtocol !== undefined))
      throw new ProblemError('bad_request', {
        detail: 'Build with AI takes a provider, address, key and model here: it has no decider.',
      })
    const next = applyChange(await ai.saved(job as AiJob), change)
    // A new provider brings its own address unless one is given with it
    if (change.provider && change.baseUrl === undefined) delete next.baseUrl
    if (Object.keys(next).length) await vault.put(`ai:${job}`, next)
    else await vault.remove(`ai:${job}`)
    if (job === 'search') await ai.searchKeyChanged()
    return c.json(await view(originOf(c)), 200)
  }

  const test: RouteHandler<Routes['test']> = async (c) => {
    requireOwner(c)
    const { job } = c.req.valid('param')
    if (job === 'search') {
      const result = await testSearch(await ai.search())
      return c.json({ job, ok: result.ok, checks: [{ name: 'Embedding', ...result }] }, 200)
    }
    if (job === 'builds') {
      const result = await testBuilds(await ai.builds())
      return c.json({ job, ok: result.ok, checks: [{ name: 'Writer', ...result }] }, 200)
    }
    const result = await testGrouping(await ai.grouping())
    return c.json(
      {
        job,
        ok: result.ok,
        checks: [
          { name: 'Writer', ...result.writer },
          { name: 'Decider', ...result.decider },
        ],
      },
      200,
    )
  }

  const models: RouteHandler<Routes['models']> = async (c) => {
    requireOwner(c)
    const { job, provider, q, for: role } = c.req.valid('query')
    const base = job === 'builds' ? await ai.builds() : await ai.grouping()
    const elsewhere = Boolean(provider) && provider !== base.provider.value
    const config = provider
      ? {
          ...base,
          provider: { value: provider, from: 'settings' as const },
          baseUrl: elsewhere ? { value: PROVIDERS[provider].baseUrl, from: 'default' as const } : base.baseUrl,
          // Build with AI never sends smart grouping's key to another provider: that provider would be its own
          key:
            elsewhere && 'connection' in base && base.connection === 'grouping'
              ? { value: '', from: 'default' as const }
              : base.key,
        }
      : base
    const all = await listModels(config).catch((error: unknown) => {
      throw new ProblemError('upstream', { detail: error instanceof AiError ? error.message : String(error) })
    })
    const words = q?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
    // TypeSafe's decision models only decide: offered to a TypeSafe decider, and to nothing else
    const fits = (model: { pinned: boolean }) =>
      role === 'typesafe' ? model.pinned : role === 'writer' || role === 'chat' ? !model.pinned : true
    const found = all.filter(
      (model) => fits(model) && words.every((word) => `${model.id} ${model.name}`.toLowerCase().includes(word)),
    )
    return c.json({ count: found.length, models: found.slice(0, 200) }, 200)
  }

  return { get, update, test, models }
}
