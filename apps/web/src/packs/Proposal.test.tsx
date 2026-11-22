import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type Schemas } from '@/api/client'
import { Proposal } from './Proposal'

vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  api: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search }: { children: React.ReactNode; to: string; search?: Record<string, string> }) => (
    <a href={`${to}${search ? `?${new URLSearchParams(search)}` : ''}`}>{children}</a>
  ),
}))

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

const GET = vi.mocked(api.GET) as unknown as ReturnType<typeof vi.fn>
const POST = vi.mocked(api.POST) as unknown as ReturnType<typeof vi.fn>
const DELETE = vi.mocked(api.DELETE) as unknown as ReturnType<typeof vi.fn>
const answer = (data: unknown, status = 200) => ({ data, response: { ok: true, status, headers: new Headers() } })
const problem = (status: number, error: unknown) => ({ error, response: { ok: false, status, headers: new Headers() } })

type Line = Schemas['PackBuildLine']
const line = (id: string, more: Partial<Line>): Line => ({
  id,
  kind: (id === 'skill' ? 'skill' : id.slice(0, id.indexOf(':'))) as Line['kind'],
  target: id === 'skill' ? 'SKILL' : id.slice(id.indexOf(':') + 1),
  change: 'add',
  before: null,
  after: null,
  reason: null,
  changesThings: false,
  suggested: true,
  needs: [],
  ...more,
})
const LINES = [
  line('tool:echo.count_slowly', { after: { tool: 'echo.count_slowly' }, reason: 'It counts along.' }),
  line('tool:items.delete_item', { after: { tool: 'items.delete_item' }, changesThings: true, suggested: false }),
  line('variable:tone', { after: { value: 'plain', description: 'How replies are worded.' } }),
  line('playbook:count-along', {
    after: '---\ntitle: Count along\n---\n\n1. Run `echo.echo`.\n',
    reason: 'For “count along”.',
  }),
  line('skill', {
    change: 'change',
    before: '## What it is for\n\nSaying things back.',
    after: '## What it is for\n\nSaying things back, and counting.',
    needs: ['tool:echo.count_slowly', 'variable:tone'],
  }),
]
const build = (more: Partial<Schemas['PackBuild']> = {}) => ({
  id: 'pb_1',
  pack: 'loud',
  mode: 'refresh',
  status: 'ready',
  step: null,
  tasks: ['count along'],
  estimate: { usd: 0.17, tokens: 29_406, modelCalls: { likely: 7, max: 10 } },
  spent: { usd: 0.31, tokens: 9000, modelCalls: 6, known: true },
  costNote: null,
  stopped: null,
  notDone: [],
  error: null,
  proposal: {
    model: 'demo/pack-writer',
    lines: LINES,
    skipped: [{ name: 'items.create_item', reason: 'It changes things, and no task needs that.' }],
    rehearsal: [
      {
        task: 'count along',
        steps: [
          { tool: 'echo.echo', ran: true, callId: 'call_1', standIn: null, error: null },
          {
            tool: 'echo.shout',
            ran: false,
            callId: null,
            standIn: '[Not run in rehearsal: echo.shout changes things. Assume it worked.]',
            error: null,
          },
        ],
        outcome: 'echo.echo answered; echo.shout would finish it.',
      },
    ],
    findings: [],
  },
  createdAt: '2026-11-22T10:00:00Z',
  finishedAt: '2026-11-22T10:00:05Z',
  _links: {},
  ...more,
})
const pack = { name: 'loud', title: 'Loud' } as Schemas['Pack']

const show = (onClose = vi.fn(), onBuildAgain = vi.fn()) => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Proposal pack={pack} id="pb_1" onClose={onClose} onBuildAgain={onBuildAgain} />
    </QueryClientProvider>,
  )
  return { onClose, onBuildAgain }
}
const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLButtonElement
const ticked = (name: string) => box(name).getAttribute('aria-checked') === 'true'

describe('a proposal', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows each line with its reason, before and after, the rehearsal and the cost', async () => {
    GET.mockResolvedValue(answer(build()))
    show()
    expect(await screen.findByRole('heading', { name: 'Proposal for Loud' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Tools · 2' })).toBeTruthy()
    expect(screen.getByText('It counts along.')).toBeTruthy()
    // A tool that changes things is said so, and starts unticked
    expect(screen.getByText('(changes things)')).toBeTruthy()
    expect(ticked('Tool items.delete_item')).toBe(false)
    expect(ticked('Tool echo.count_slowly')).toBe(true)
    // The skill's change as a diff, a new playbook as it reads
    const skill = screen.getByRole('listitem', { name: 'The skill' })
    expect(within(skill).getByText('Saying things back, and counting.')).toBeTruthy()
    expect(within(skill).getByText('Needs Tool echo.count_slowly and Variable tone')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Left out · 1' })).toBeTruthy()
    expect(screen.getByText('It changes things, and no task needs that.')).toBeTruthy()
    // The rehearsal: what ran, linked to its call, and what was skipped
    expect(screen.getByText('count along: echo.echo answered; echo.shout would finish it, shout skipped')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'echo.echo ran' }).getAttribute('href')).toBe(
      '/activity?outcome=all&via=rehearsal&call=call_1',
    )
    expect(screen.getByText('shout skipped: it changes things, so it was not tried')).toBeTruthy()
    expect(screen.getByText('$0.31 of $1.00')).toBeTruthy()
  })

  it('ticks what a line needs, and holds a line a ticked one needs', async () => {
    const user = userEvent.setup()
    GET.mockResolvedValue(answer(build()))
    show()
    await screen.findByRole('heading', { name: 'Proposal for Loud' })
    await user.click(box('Variable tone'))
    expect(ticked('Variable tone')).toBe(true)
    expect(screen.getByText('The skill needs this: untick it first.')).toBeTruthy()
    await user.click(box('The skill'))
    await user.click(box('Variable tone'))
    expect(ticked('Variable tone')).toBe(false)
    await user.click(box('The skill'))
    expect([ticked('The skill'), ticked('Variable tone'), ticked('Tool echo.count_slowly')]).toEqual([true, true, true])
  })

  it('accepts the ticked lines, and says each refused one beside its line', async () => {
    const user = userEvent.setup()
    GET.mockResolvedValue(answer(build()))
    POST.mockResolvedValueOnce(
      problem(400, {
        detail: 'Not saved: the playbook names a tool that is not in the pack.',
        errors: [{ path: 'playbooks.count-along', message: '`echo.echo` is not in Loud.' }],
      }),
    )
    const { onClose } = show()
    await screen.findByRole('heading', { name: 'Proposal for Loud' })
    await user.click(box('The skill'))
    await user.click(box('Tool echo.count_slowly'))
    await user.click(box('Variable tone'))
    await user.click(screen.getByRole('button', { name: 'Accept selected (1)' }))
    await screen.findByText('Not saved: the playbook names a tool that is not in the pack.')
    expect(
      within(screen.getByRole('listitem', { name: 'Playbook count-along' })).getByText('`echo.echo` is not in Loud.'),
    ).toBeTruthy()
    expect(POST).toHaveBeenCalledWith('/api/packs/{name}/builds/{id}/accept', {
      params: { path: { name: 'loud', id: 'pb_1' } },
      body: { lines: ['playbook:count-along'] },
    })
    POST.mockResolvedValueOnce(answer({ name: 'loud', title: 'Loud' }))
    await user.click(screen.getByRole('button', { name: 'Accept all' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(POST).toHaveBeenLastCalledWith('/api/packs/{name}/builds/{id}/accept', {
      params: { path: { name: 'loud', id: 'pb_1' } },
      body: { lines: ['tool:echo.count_slowly', 'variable:tone', 'playbook:count-along', 'skill'] },
    })
  })

  it('discards after asking, leaving the pack as it is', async () => {
    const user = userEvent.setup()
    GET.mockResolvedValue(answer(build()))
    DELETE.mockResolvedValue({ data: undefined, response: { ok: true, status: 204, headers: new Headers() } })
    const { onClose } = show()
    await screen.findByRole('heading', { name: 'Proposal for Loud' })
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText(/Loud stays as it is\./)).toBeTruthy()
    await user.click(within(confirm).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(DELETE).toHaveBeenCalledWith('/api/packs/{name}/builds/{id}', {
      params: { path: { name: 'loud', id: 'pb_1' } },
    })
  })

  it('says the step a running build is on', async () => {
    GET.mockResolvedValue(answer(build({ status: 'running', step: 'Writing the skill', proposal: null })))
    show()
    expect(await screen.findByText('Writing the skill')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Refreshing Loud with AI' })).toBeTruthy()
  })

  it('says where a stopped build stopped, and what is here can still be accepted', async () => {
    GET.mockResolvedValue(
      answer(build({ status: 'stopped', stopped: 'cap', notDone: ['the rehearsal of “count along”'] })),
    )
    show()
    expect(
      await screen.findByText(
        'Stopped at $1.00. Not done: the rehearsal of “count along”. What is here can still be accepted.',
      ),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Accept all' })).toBeTruthy()
  })

  it('says why a build failed, and offers to build again', async () => {
    const user = userEvent.setup()
    GET.mockResolvedValue(
      answer(build({ status: 'failed', error: 'The model’s answer for the kit didn’t fit.', proposal: null })),
    )
    const { onBuildAgain } = show()
    expect(await screen.findByText('The model’s answer for the kit didn’t fit.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Build again' }))
    expect(onBuildAgain).toHaveBeenCalled()
  })

  it('says a link to a build that is gone leads nowhere', async () => {
    GET.mockResolvedValue(problem(404, { detail: 'Loud has no build pb_1.' }))
    show()
    expect(await screen.findByText('Loud has no build pb_1.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back to Loud' })).toBeTruthy()
  })
})
