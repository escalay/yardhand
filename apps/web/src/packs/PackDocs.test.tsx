import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type Schemas } from '@/api/client'
import { PackDocs } from './PackDocs'

vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  api: { GET: vi.fn(), POST: vi.fn(), PUT: vi.fn(), DELETE: vi.fn() },
}))

type Pack = Schemas['Pack']

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

const answer = (data: unknown, status = 200) => ({ data, response: { ok: true, status } })
const problem = (status: number, error: unknown) => ({ error, response: { ok: false, status } })

const GET = vi.mocked(api.GET) as unknown as ReturnType<typeof vi.fn>
const PUT = vi.mocked(api.PUT) as unknown as ReturnType<typeof vi.fn>
const DELETE = vi.mocked(api.DELETE) as unknown as ReturnType<typeof vi.fn>

const HELLO = '---\ntitle: Say hello\n---\n\n1. Run `echo.echo`.\n'
const sayHello = {
  name: 'say-hello',
  title: 'Say hello',
  description: 'Greets a guest by name.',
  arguments: [{ name: 'guest', description: 'Who to greet.', required: true }],
  steps: 3,
  flag: null,
  findings: [],
}
const skill = { uri: 'skill://loud/SKILL.md', sections: ['What it is for', 'Playbooks'], flag: null, findings: [] }
const changed = { was: 'written for echo.echo', now: 'echo.echo now reads: Echoes, loudly.' }
const left = {
  level: 'error',
  code: 'left_pack',
  path: 'playbooks.say-hello',
  message: '`greet` is no longer a tool of Loud: write the name it has now, or take it out of the text.',
}

const packOf = (own: Partial<Pick<Pack, 'ownPlaybooks' | 'skill'>>) =>
  ({
    name: 'loud',
    title: 'Loud',
    description: 'Say things back, loudly.',
    variables: [],
    tools: [],
    playbooks: [],
    manuals: [],
    ownPlaybooks: [],
    skill: null,
    ...own,
  }) as unknown as Pack

const show = (own: Partial<Pick<Pack, 'ownPlaybooks' | 'skill'>> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PackDocs pack={packOf(own)} onPatch={vi.fn()} />
    </QueryClientProvider>,
  )
const part = (name: RegExp) => {
  const section = screen.getByRole('heading', { name }).closest('section')
  if (!section) throw new Error(`no section ${name}`)
  return within(section)
}

describe('what is written for a pack', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('says what a playbook and the skill are for while the pack has neither', () => {
    show()
    expect(part(/^Written for this pack · 0/).getByText(/No playbook is written for Loud yet\./)).toBeTruthy()
    expect(part(/^Skill/).getByText(/Loud has no skill yet\./)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Write a playbook' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Write the skill' })).toBeTruthy()
    // What it holds from its connections stays below
    expect(screen.getByRole('heading', { name: /^Playbooks from its connections · 0/ })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /^Manuals · 0/ })).toBeTruthy()
  })

  it('lists each playbook with its steps and arguments, and the skill with its sections', () => {
    const warned = { level: 'warning', code: 'split', path: 'playbooks.say-hello', message: '14 steps: split it.' }
    show({ ownPlaybooks: [{ ...sayHello, findings: [warned] }] as never, skill: skill as never })
    const own = part(/^Written for this pack · 1/)
    expect(own.getByText('Say hello')).toBeTruthy()
    expect(own.getByText('say-hello')).toBeTruthy()
    expect(own.getByText('Greets a guest by name.')).toBeTruthy()
    expect(own.getByText('3 steps · takes guest')).toBeTruthy()
    expect(own.getByText('This playbook has 14 steps. Agents follow about 12 well: split it in two.')).toBeTruthy()
    const written = part(/^Skill/)
    expect(written.getByText('Working with Loud')).toBeTruthy()
    expect(written.getByText('skill://loud/SKILL.md')).toBeTruthy()
    expect(
      written.getByText('2 of 6 sections · no Which tool for which job, Values already set, Gotchas, What it can’t do'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Write the skill' })).toBeNull()
  })

  it('clears a flag by saving the text as it is, when its tool only changed', async () => {
    const user = userEvent.setup()
    GET.mockResolvedValue(answer({ markdown: HELLO }))
    PUT.mockResolvedValue(answer({}))
    show({ ownPlaybooks: [{ ...sayHello, flag: changed }] as never })
    expect(screen.getByText('It was written for echo.echo, which changed or left the pack since')).toBeTruthy()
    expect(screen.getByText('echo.echo now reads: Echoes, loudly.')).toBeTruthy()
    expect(screen.getByText(/Read it again: saving it, changed or not, clears this\./)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Save say-hello as it is' }))
    await waitFor(() =>
      expect(PUT).toHaveBeenCalledWith('/api/packs/{name}/playbooks/{playbook}', {
        params: { path: { name: 'loud', playbook: 'say-hello' } },
        body: { markdown: HELLO },
      }),
    )
  })

  it('sends a flagged text to the editor when it names a tool that left, and says a refused save', async () => {
    const user = userEvent.setup()
    show({
      ownPlaybooks: [
        { ...sayHello, flag: { was: 'written for greet', now: 'greet is no longer in Loud' }, findings: [left] },
      ] as never,
      skill: { ...skill, flag: changed } as never,
    })
    expect(screen.getByText(/Edit it: it can’t be saved as it is\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save say-hello as it is' })).toBeNull()
    expect(screen.getByText(left.message)).toBeTruthy()
    // The skill's tool only changed, but the gateway may still say no
    GET.mockResolvedValue(answer({ markdown: '## What it is for\n' }))
    PUT.mockResolvedValue(problem(400, { detail: 'Not saved: {{door}} is no variable of Loud.', errors: [] }))
    await user.click(screen.getByRole('button', { name: 'Save the skill as it is' }))
    expect(await screen.findByText('Not saved: {{door}} is no variable of Loud.')).toBeTruthy()
    expect(PUT.mock.calls[0]?.[1]).toEqual({
      params: { path: { name: 'loud' } },
      body: { markdown: '## What it is for\n' },
    })
  })

  it('asks before removing a playbook or the skill, with every version of it', async () => {
    const user = userEvent.setup()
    DELETE.mockResolvedValue(answer(undefined, 204))
    show({ ownPlaybooks: [sayHello] as never, skill: skill as never })
    await user.click(screen.getByRole('button', { name: 'Remove say-hello' }))
    const asked = screen.getByRole('alertdialog')
    expect(asked.textContent).toContain('Remove say-hello?')
    expect(asked.textContent).toContain('every version of it')
    expect(DELETE).not.toHaveBeenCalled()
    await user.click(within(asked).getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(DELETE).toHaveBeenCalledWith('/api/packs/{name}/playbooks/{playbook}', {
        params: { path: { name: 'loud', playbook: 'say-hello' } },
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Remove the skill' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(DELETE).toHaveBeenCalledWith('/api/packs/{name}/skill', { params: { path: { name: 'loud' } } }),
    )
  })

  it('opens the editor in place: a new playbook, a stored one, the skill', async () => {
    const user = userEvent.setup()
    GET.mockResolvedValue(answer({ markdown: HELLO, version: 'pdv_1', versions: [] }))
    vi.mocked(api.POST as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(answer({ findings: [] }))
    show({ ownPlaybooks: [sayHello] as never })
    await user.click(screen.getByRole('button', { name: 'Write a playbook' }))
    expect(screen.getByLabelText('Title')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Title')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Edit say-hello' }))
    await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>('Text').value).toBe(HELLO))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Write the skill' }))
    expect(screen.getByLabelText<HTMLTextAreaElement>('Text').value).toMatch(/^## What it is for/)
  })
})
