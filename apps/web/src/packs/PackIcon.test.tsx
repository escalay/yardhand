import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type Schemas } from '@/api/client'
import { IconSection, PackIcon } from './PackIcon'

vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  api: { PUT: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}))

type Pack = Schemas['Pack']
const mocked = (fn: unknown) => vi.mocked(fn) as unknown as ReturnType<typeof vi.fn>
const PUT = mocked(api.PUT)
const PATCH = mocked(api.PATCH)
const DELETE = mocked(api.DELETE)
const answer = (data: unknown) => ({ data, response: { ok: true, status: 200 } })
const problem = (status: number, detail: string) => ({ error: { detail }, response: { ok: false, status } })

const PALETTE = ['#006ad9', '#6d28d9', '#0f766e'] as Pack['palette']
const packOf = (icon: Partial<Pack['icon']>) =>
  ({
    name: 'desk',
    title: 'Desk',
    palette: PALETTE,
    icon: {
      source: 'monogram',
      letter: 'D',
      colour: '#6d28d9',
      set: false,
      etag: 'e1',
      url: 'http://localhost/p/desk/icon-96.png?v=e1',
      ...icon,
    },
  }) as unknown as Pack

const show = (pack: Pack) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IconSection pack={pack} />
    </QueryClientProvider>,
  )

describe('a pack’s icon', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('is shown from its open address, with its version so a new one is fetched', () => {
    render(<PackIcon icon={packOf({}).icon} />)
    expect(screen.getByRole('presentation').getAttribute('src')).toBe('/p/desk/icon-96.png?v=e1')
  })

  it('uploads an SVG or a PNG as it is', async () => {
    const user = userEvent.setup()
    PUT.mockResolvedValue(answer({}))
    show(packOf({}))
    const file = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'mark.svg', { type: 'image/svg+xml' })
    await user.upload(screen.getByLabelText('An SVG or PNG for Desk’s icon'), file)
    await waitFor(() => expect(PUT).toHaveBeenCalled())
    const [path, request] = PUT.mock.calls[0] as [string, { body: File; headers: Record<string, string> }]
    expect(path).toBe('/api/packs/{name}/icon')
    expect(request.body).toBe(file)
    expect(request.headers['content-type']).toBe('image/svg+xml')
  })

  it('says why an upload was refused', async () => {
    const user = userEvent.setup()
    PUT.mockResolvedValue(problem(400, 'The icon is 400 × 100, too far from square.'))
    show(packOf({}))
    await user.upload(
      screen.getByLabelText('An SVG or PNG for Desk’s icon'),
      new File(['x'], 'wide.png', { type: 'image/png' }),
    )
    expect((await screen.findByRole('alert')).textContent).toContain('too far from square')
  })

  it('recolours the monogram from the palette, the colour it has pressed', async () => {
    const user = userEvent.setup()
    PATCH.mockResolvedValue(answer({}))
    show(packOf({}))
    expect(screen.getByRole('button', { name: 'Colour #6d28d9' }).getAttribute('aria-pressed')).toBe('true')
    await user.click(screen.getByRole('button', { name: 'Colour #0f766e' }))
    await waitFor(() => expect(PATCH).toHaveBeenCalled())
    expect(PATCH).toHaveBeenCalledWith('/api/packs/{name}/icon', {
      params: { path: { name: 'desk' } },
      body: { colour: '#0f766e' },
    })
  })

  it('goes back to the monogram only from an icon the owner set', async () => {
    const user = userEvent.setup()
    DELETE.mockResolvedValue(answer({}))
    show(packOf({}))
    expect(screen.queryByRole('button', { name: /^Back to/ })).toBeNull()
    cleanup()
    // A colour picked goes back to its name's own
    show(packOf({ set: true }))
    expect(screen.getByRole('button', { name: 'Back to its own colour' })).toBeTruthy()
    cleanup()
    show(packOf({ source: 'upload', colour: null, set: true }))
    // No colour is pressed while an uploaded icon is shown
    expect(screen.getByRole('button', { name: 'Colour #6d28d9' }).getAttribute('aria-pressed')).toBe('false')
    await user.click(screen.getByRole('button', { name: 'Back to the monogram' }))
    await waitFor(() =>
      expect(DELETE).toHaveBeenCalledWith('/api/packs/{name}/icon', { params: { path: { name: 'desk' } } }),
    )
  })
})
