import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type Schemas } from '@/api/client'
import { BuildDialog } from './BuildDialog'

vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  api: { GET: vi.fn(), POST: vi.fn() },
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, hash }: { children: React.ReactNode; to: string; hash?: string }) => (
    <a href={`${to}${hash ? `#${hash}` : ''}`}>{children}</a>
  ),
}))

const POST = vi.mocked(api.POST) as unknown as ReturnType<typeof vi.fn>
const answer = (data: unknown, status = 200) => ({ data, response: { ok: true, status, headers: new Headers() } })
const problem = (status: number, error: unknown, headers: Record<string, string> = {}) => ({
  error,
  response: { ok: false, status, headers: new Headers(headers) },
})

const estimate = {
  mode: 'refresh',
  usd: 0.17,
  capUsd: 1,
  priceKnown: true,
  note: null,
  modelCalls: { likely: 7, max: 10 },
  tokens: 29_406,
  model: 'demo/pack-writer',
  realCalls: 6,
  _links: {},
}
const pack = {
  name: 'loud',
  title: 'Loud',
  description: 'Say things back, loudly.',
  tools: [{ name: 'echo.echo' }],
  build: null,
} as unknown as Schemas['Pack']

const show = (mode: 'build' | 'refresh' = 'refresh', onStarted = vi.fn()) => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <BuildDialog pack={pack} mode={mode} open onOpenChange={vi.fn()} onEdit={vi.fn()} onStarted={onStarted} />
    </QueryClientProvider>,
  )
  return onStarted
}
const byPath = (handlers: Record<string, () => unknown>) =>
  POST.mockImplementation(async (path: string) => {
    const handler = handlers[path]
    if (!handler) throw new Error(`no answer for ${path}`)
    return handler()
  })

describe('starting a build', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the purpose, then the estimate for the tasks given, and only then starts', async () => {
    const user = userEvent.setup()
    byPath({
      '/api/packs/{name}/builds/estimate': () => answer(estimate),
      '/api/packs/{name}/builds': () => answer({ id: 'pb_1', status: 'running' }, 202),
    })
    const onStarted = show()
    expect(screen.getByRole('heading', { name: 'Refresh Loud with AI' })).toBeTruthy()
    expect(screen.getByText('Say things back, loudly.')).toBeTruthy()
    const start = screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement
    expect(start.disabled).toBe(true)
    await user.type(screen.getByLabelText('Task 1'), 'count to three, then say it back')
    await screen.findByText(
      'About $0.17 of $1.00. It tries each task first: up to 6 real read calls on your accounts (those may cost on their own), and what they return is sent to demo/pack-writer. Tools that change things are never run.',
    )
    expect(
      screen.getByText('Refresh also sends the pack as it is: its tools, wording, variables and the values it fills.'),
    ).toBeTruthy()
    expect(POST).toHaveBeenCalledWith('/api/packs/{name}/builds/estimate', {
      params: { path: { name: 'loud' } },
      body: { mode: 'refresh', tasks: ['count to three, then say it back'] },
    })
    await waitFor(() => expect(start.disabled).toBe(false))
    await user.click(start)
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('pb_1'))
  })

  it('takes up to five tasks', async () => {
    const user = userEvent.setup()
    byPath({ '/api/packs/{name}/builds/estimate': () => answer(estimate) })
    show('build')
    expect(screen.getByRole('heading', { name: 'Build Loud with AI' })).toBeTruthy()
    for (let count = 1; count < 5; count++) await user.click(screen.getByRole('button', { name: 'Add a task' }))
    expect(screen.getByLabelText('Task 5')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add a task' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Take task 5 out' }))
    expect(screen.queryByLabelText('Task 5')).toBeNull()
  })

  it('holds back a build estimated over the cap', async () => {
    const user = userEvent.setup()
    byPath({ '/api/packs/{name}/builds/estimate': () => answer({ ...estimate, usd: 1.4 }) })
    show()
    await user.type(screen.getByLabelText('Task 1'), 'read every inbox there is')
    await screen.findByText(/About \$1\.40 of \$1\.00\./)
    expect(screen.getByText('That is over the $1.00 a build may spend: give fewer example tasks.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends the owner to Settings › AI when there is no model to ask', async () => {
    const user = userEvent.setup()
    byPath({
      '/api/packs/{name}/builds/estimate': () =>
        problem(409, {
          code: 'conflict',
          detail: 'Build with AI has no model to ask: give it a key in Settings › AI (PATCH /api/ai/builds).',
        }),
    })
    show()
    await user.type(screen.getByLabelText('Task 1'), 'say it back')
    await screen.findByText(/Build with AI has no model to ask/)
    expect(screen.getByRole('link', { name: 'Open Settings › AI' }).getAttribute('href')).toBe(
      '/settings#build-with-ai',
    )
  })

  it('says when the hour’s builds are used up', async () => {
    const user = userEvent.setup()
    byPath({
      '/api/packs/{name}/builds/estimate': () => answer(estimate),
      '/api/packs/{name}/builds': () =>
        problem(429, { code: 'too_many_requests', detail: 'More than 6 calls…' }, { 'retry-after': '600' }),
    })
    show()
    await user.type(screen.getByLabelText('Task 1'), 'say it back')
    const start = screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement
    await waitFor(() => expect(start.disabled).toBe(false))
    await user.click(start)
    await screen.findByText('Loud has had six builds this hour, counting refused ones: try again in 10 minutes.')
  })
})
