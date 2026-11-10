/** AI handlers (owner only). A key goes into the vault and never comes back out: only whether it is set. */
import type { RouteHandler } from '@hono/zod-openapi'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import type { Services } from '../../services.js'
import { requireOwner } from '../clients/principals.js'
import { AiError, listModels, testGrouping, testSearch } from './clients.js'
import { type AiJob, applyChange, ENV_NAMES, type Field, PROVIDERS } from './config.js'
import type { routes } from './routes.js'

type Routes = typeof routes

const withEnv = <T>(field: Field<T>, env: string | null) => ({ ...field, env })

export const aiHandlers = ({ ai, vault }: Services) => {
  const view = async (origin: string) => {
    const [search, grouping] = await Promise.all([ai.search(), ai.grouping()])
    const names = ENV_NAMES.grouping
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
    const { provider, q, for: role } = c.req.valid('query')
    const grouping = await ai.grouping()
    const config = provider
      ? {
          ...grouping,
          provider: { value: provider, from: 'settings' as const },
          baseUrl:
            provider === grouping.provider.value
              ? grouping.baseUrl
              : { value: PROVIDERS[provider].baseUrl, from: 'default' as const },
        }
      : grouping
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
