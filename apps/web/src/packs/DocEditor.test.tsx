import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type Schemas } from '@/api/client'
import { DocEditor, type DocTarget } from './DocEditor'
import { starterPlaybook } from './docs.rules'

vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  api: { GET: vi.fn(), POST: vi.fn(), PUT: vi.fn() },
}))

type Pack = Schemas['Pack']
type Finding = Schemas['PackFinding']

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

const answer = (data: unknown) => ({ data, response: { ok: true, status: 200 } })
const problem = (status: number, error: unknown) => ({ error, response: { ok: false, status } })
const never = new Promise(() => {})

const GET = vi.mocked(api.GET) as unknown as ReturnType<typeof vi.fn>
const POST = vi.mocked(api.POST) as unknown as ReturnType<typeof vi.fn>
const PUT = vi.mocked(api.PUT) as unknown as ReturnType<typeof vi.fn>

const CHECKS = '/api/packs/{name}/checks'
const PLAYBOOKS = '/api/packs/{name}/playbooks'
const PLAYBOOK = '/api/packs/{name}/playbooks/{playbook}'
const SKILL = '/api/packs/{name}/skill'

const pack = {
  name: 'loud',
  title: 'Loud',
  description: 'Say things back, loudly.',
  variables: [{ name: 'page_size', value: 5, description: null, usedBy: [] }],
  tools: [{ name: 'echo.echo', wording: null, upstreamDescription: 'Echoes the text back.', fixed: {}, defaults: {} }],
  playbooks: [{ name: 'echo-warm-up', title: 'Echo · Warm up', description: 'Warms up.' }],
  ownPlaybooks: [{ name: 'say-hello', title: 'Say hello', description: 'Greets a guest.' }],
  skill: null,
} as unknown as Pack

const HELLO = '---\ntitle: Say hello\n---\n\n1. Run `echo.echo` with {{page_size}} words.\n'
const OLDER = '---\ntitle: Say hello\n---\n\n1. Run `echo.echo`.\n'
const versions = [
  { id: 'pdv_2', source: 'owner', createdAt: '2026-11-20T09:30:00.000Z', live: true },
  { id: 'pdv_1', source: 'import', createdAt: '2026-11-19T09:30:00.000Z', live: false },
]
const stored = (markdown: string, version: string) => ({ name: 'say-hello', markdown, version, versions })

const notInPack: Finding = {
  level: 'error',
  code: 'not_in_pack',
  path: 'playbooks.say-hello',
  message: '`echo.delete_menus` is not in Loud: add it to the pack, or take it out of the text.',
}
const needsWrite: Finding = {
  level: 'warning',
  code: 'needs_write',
  path: 'playbooks.say-hello',
  message: '`echo.echo` changes things: a read-only key can’t run it.',
}

/** What the gateway is asked to check last, and to save. */
const checked = () => POST.mock.calls.filter(([path]) => path === CHECKS).at(-1)?.[1].body
const posts = (path: string) => POST.mock.calls.filter(([asked]) => asked === path).map(([, init]) => init.body)

const show = (target: DocTarget, onDone = vi.fn()) => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DocEditor pack={pack} target={target} onDone={onDone} />
    </QueryClientProvider>,
  )
  return onDone
}
const text = () => screen.getByLabelText<HTMLTextAreaElement>('Text')
const save = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })

describe('the editor for a pack’s own playbooks and its skill', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('names a new playbook after its title, starts its text, and checks it as it is written', async () => {
    const user = userEvent.setup()
    POST.mockImplementation((path: string) => (path === CHECKS ? Promise.resolve(answer({ findings: [] })) : never))
    show({ kind: 'playbook', name: null })
    // Nothing to save under until it has a name
    expect(save('Save playbook').disabled).toBe(true)
    await user.type(screen.getByLabelText('Title'), 'Find roles')
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('find-roles')
    expect(text().value).toBe(starterPlaybook('Find roles'))
    expect(await screen.findByText('✓ Every tool named is in the pack and every {{…}} resolves')).toBeTruthy()
    await waitFor(() =>
      expect(checked()).toEqual({ kind: 'playbook', name: 'find-roles', markdown: starterPlaybook('Find roles') }),
    )
    await user.click(save('Save playbook'))
    expect(posts(PLAYBOOKS)).toEqual([{ name: 'find-roles', markdown: starterPlaybook('Find roles') }])
    expect(save('Saving…').disabled).toBe(true)
  })

  it('says a name the pack already has, and checks the draft under no name', async () => {
    const user = userEvent.setup()
    POST.mockResolvedValue(answer({ findings: [] }))
    show({ kind: 'playbook', name: null })
    await user.type(screen.getByLabelText('Title'), 'Say hello')
    expect(
      screen.getByText('say-hello is already a playbook written for this pack: edit that one, or pick another name.'),
    ).toBeTruthy()
    await waitFor(() => expect(checked()).toEqual({ kind: 'playbook', markdown: starterPlaybook('Say hello') }))
    expect(save('Save playbook').disabled).toBe(true)
    // A name typed by hand stays when the title moves on
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'greet-a-guest')
    await user.type(screen.getByLabelText('Title'), ' again')
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('greet-a-guest')
    await waitFor(() => expect(save('Save playbook').disabled).toBe(false))
  })

  it('lists what the checks find, problems first, and holds the save until they are gone', async () => {
    GET.mockResolvedValue(answer(stored(HELLO, 'pdv_2')))
    POST.mockResolvedValueOnce(answer({ findings: [needsWrite, notInPack] })).mockResolvedValue(
      answer({ findings: [needsWrite] }),
    )
    PUT.mockResolvedValue(answer(stored(HELLO, 'pdv_3')))
    const onDone = show({ kind: 'playbook', name: 'say-hello' })
    await waitFor(() => expect(text().value).toBe(HELLO))
    // Said as it changes, without interrupting: a status, not an alert
    const status = await screen.findByRole('status')
    await within(status).findByText('1 problem to fix before it can be saved · 1 thing to look at')
    expect(
      within(status)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([notInPack.message, needsWrite.message])
    expect(checked()).toEqual({ kind: 'playbook', name: 'say-hello', markdown: HELLO })
    expect(save('Save playbook').disabled).toBe(true)

    const fixed = `${HELLO}2. Say it back.\n`
    fireEvent.change(text(), { target: { value: fixed } })
    await within(status).findByText('✓ Every tool named is in the pack and every {{…}} resolves · 1 thing to look at')
    expect(checked()).toEqual({ kind: 'playbook', name: 'say-hello', markdown: fixed })
    fireEvent.click(save('Save playbook'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(PUT).toHaveBeenCalledWith(PLAYBOOK, {
      params: { path: { name: 'loud', playbook: 'say-hello' } },
      body: { markdown: fixed },
    })
  })

  it('says why a save was refused, each problem as the gateway words it, and stays open', async () => {
    GET.mockResolvedValue(answer(stored(HELLO, 'pdv_2')))
    POST.mockResolvedValue(answer({ findings: [] }))
    PUT.mockResolvedValue(
      problem(400, {
        detail: 'Not saved: `echo.delete_menus` is not in Loud.',
        errors: [{ path: 'playbooks.say-hello', message: notInPack.message }],
      }),
    )
    const onDone = show({ kind: 'playbook', name: 'say-hello' })
    await waitFor(() => expect(save('Save playbook').disabled).toBe(false))
    fireEvent.click(save('Save playbook'))
    expect((await screen.findByRole('alert')).textContent).toBe(notInPack.message)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('loads an older text from its versions, to read or to save again', async () => {
    const user = userEvent.setup()
    GET.mockImplementation((_path: string, init: { params: { query: { version?: string } } }) =>
      Promise.resolve(answer(init.params.query.version === 'pdv_1' ? stored(OLDER, 'pdv_1') : stored(HELLO, 'pdv_2'))),
    )
    POST.mockResolvedValue(answer({ findings: [] }))
    show({ kind: 'playbook', name: 'say-hello' })
    await waitFor(() => expect(text().value).toBe(HELLO))
    await user.click(screen.getByRole('button', { name: 'Versions of say-hello' }))
    await user.click(await screen.findByRole('menuitem', { name: /from a config import/ }))
    await waitFor(() => expect(text().value).toBe(OLDER))
    expect(screen.getByText(/This is an older text, from .+\. Saving it serves it again\./)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Back to the served text' }))
    await waitFor(() => expect(text().value).toBe(HELLO))
  })

  it('shows the text as agents read it: no front matter, the pack’s variables filled in', async () => {
    GET.mockResolvedValue(answer(stored(HELLO, 'pdv_2')))
    POST.mockResolvedValue(answer({ findings: [] }))
    show({ kind: 'playbook', name: 'say-hello' })
    const preview = await screen.findByRole('region', { name: 'As agents read it' })
    await within(preview).findByText(/with 5 words\./)
    expect(preview.textContent).not.toContain('title: Say hello')
  })

  it('starts a new skill from its six sections, under the heading the gateway writes', async () => {
    POST.mockResolvedValue(answer({ findings: [] }))
    PUT.mockReturnValue(never)
    show({ kind: 'skill', exists: false })
    expect(text().value).toMatch(/^## What it is for\n\nSay things back, loudly\.\n/)
    expect(text().value).toContain('- page_size: {{page_size}}.')
    const preview = screen.getByRole('region', { name: 'As agents read it' })
    expect(within(preview).getByRole('heading', { name: 'Working with Loud' })).toBeTruthy()
    expect(within(preview).getByText('page_size: 5.')).toBeTruthy()
    await waitFor(() => expect(checked()).toEqual({ kind: 'skill', markdown: text().value }))
    await waitFor(() => expect(save('Save skill').disabled).toBe(false))
    fireEvent.click(save('Save skill'))
    await waitFor(() =>
      expect(PUT).toHaveBeenCalledWith(SKILL, { params: { path: { name: 'loud' } }, body: { markdown: text().value } }),
    )
  })

  it('says so when a text can’t be read, and when there is nothing to check', async () => {
    GET.mockResolvedValue(problem(404, { detail: 'Loud has no playbook of its own called say-hello.' }))
    show({ kind: 'playbook', name: 'say-hello' })
    expect(await screen.findByText(/Loud has no playbook of its own called say-hello\./)).toBeTruthy()
    cleanup()
    POST.mockResolvedValue(answer({ findings: [] }))
    show({ kind: 'skill', exists: false })
    fireEvent.change(text(), { target: { value: '  ' } })
    expect(await screen.findByText('Nothing to check yet: write the text.')).toBeTruthy()
    expect(save('Save skill').disabled).toBe(true)
  })
})
