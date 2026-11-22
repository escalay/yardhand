import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type Schemas } from '@/api/client'
import { PackVariables } from './PackVariables'

vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  api: { PUT: vi.fn() },
}))

type Pack = Schemas['Pack']

// Radix measures its switches and radios, which jsdom can't
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

const packOf = (variables: Pack['variables']) =>
  ({
    name: 'loud',
    title: 'Loud',
    variables,
    tools: [{ name: 'items.get_item', fixed: {}, defaults: { limit: '{{page_size}}' } }],
  }) as unknown as Pack

const pageSize = {
  name: 'page_size',
  value: 5,
  description: 'How many items a look-up returns.',
  perPerson: false,
  usedBy: ['items.get_item'],
}

const PUT = vi.mocked(api.PUT) as unknown as ReturnType<typeof vi.fn>

const show = (variables: Pack['variables']) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PackVariables pack={packOf(variables)} />
    </QueryClientProvider>,
  )

describe('a pack’s variables', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('says what a variable is when the pack has none', () => {
    show([])
    expect(screen.getByText(/No variables yet\. A variable is a value with a name/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add a variable' })).toBeTruthy()
  })

  it('lists each variable as it is written, with its value and the tools that write it', () => {
    show([pageSize, { name: 'desk', value: 'the desk', description: null, perPerson: false, usedBy: [] }])
    expect(screen.getByText('{{page_size}}')).toBeTruthy()
    expect(screen.getByText('How many items a look-up returns.')).toBeTruthy()
    expect(screen.getByText('Used by items.get_item')).toBeTruthy()
    expect(screen.getByText('Not used yet')).toBeTruthy()
  })

  it('adds a variable by sending the whole set, the others as they are', async () => {
    const user = userEvent.setup()
    PUT.mockReturnValue(new Promise(() => {}))
    show([pageSize])
    await user.click(screen.getByRole('button', { name: 'Add a variable' }))
    await user.type(screen.getByLabelText('Name'), 'Desk')
    expect(screen.getByText(/^Start with a lowercase letter/)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save variable' }).disabled).toBe(true)
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'desk')
    await user.type(screen.getByLabelText('Value'), 'the desk')
    await user.click(screen.getByRole('button', { name: 'Save variable' }))
    expect(PUT).toHaveBeenCalledWith('/api/packs/{name}/variables', {
      params: { path: { name: 'loud' } },
      body: {
        variables: [
          { name: 'page_size', value: 5, description: 'How many items a look-up returns.' },
          { name: 'desk', value: 'the desk', description: null },
        ],
      },
    })
    // Until the gateway answers, the form says it is saving and can't be sent twice
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Saving…' }).disabled).toBe(true)
  })

  it('changes a value in its own kind: a number stays a number', async () => {
    const user = userEvent.setup()
    PUT.mockResolvedValue(answer(packOf([{ ...pageSize, value: 7 }])))
    show([pageSize])
    await user.click(screen.getByRole('button', { name: 'Change page_size' }))
    expect(screen.getByLabelText<HTMLInputElement>('Name').disabled).toBe(true)
    await user.clear(screen.getByLabelText('Value'))
    await user.type(screen.getByLabelText('Value'), '7')
    await user.click(screen.getByRole('button', { name: 'Save variable' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save variable' })).toBeNull())
    expect(PUT.mock.calls[0]?.[1].body).toEqual({
      variables: [{ name: 'page_size', value: 7, description: 'How many items a look-up returns.' }],
    })
  })

  it('says beside a variable why it can’t be removed', async () => {
    const user = userEvent.setup()
    const said = '{{page_size}} is still used by items.get_item (limit): change that first, or keep the variable.'
    PUT.mockResolvedValue(
      problem(400, { detail: `Not saved: ${said}`, errors: [{ path: 'variables.page_size', message: said }] }),
    )
    show([pageSize])
    await user.click(screen.getByRole('button', { name: 'Remove page_size' }))
    expect(await screen.findByText(said)).toBeTruthy()
    expect(PUT.mock.calls[0]?.[1].body).toEqual({ variables: [] })
    expect(screen.getByText('{{page_size}}')).toBeTruthy()
  })

  it('says beside a variable which tool its new value no longer fits', async () => {
    const user = userEvent.setup()
    PUT.mockResolvedValue(
      problem(400, {
        detail: 'Not saved: limit must be integer.',
        errors: [{ path: 'tools.items.get_item.defaults.limit', message: 'limit must be integer' }],
      }),
    )
    show([pageSize])
    await user.click(screen.getByRole('button', { name: 'Change page_size' }))
    await user.clear(screen.getByLabelText('Value'))
    await user.type(screen.getByLabelText('Value'), '2.5')
    await user.click(screen.getByRole('button', { name: 'Save variable' }))
    expect(await screen.findByText('items.get_item: limit must be integer.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save variable' })).toBeTruthy()
  })

  it('says under the card what went wrong when the answer names no place', async () => {
    const user = userEvent.setup()
    PUT.mockResolvedValue(problem(503, { detail: 'The gateway is restarting: try again in a moment.' }))
    show([{ ...pageSize, perPerson: false, usedBy: [] }])
    await user.click(screen.getByRole('button', { name: 'Remove page_size' }))
    expect(await screen.findByText('The gateway is restarting: try again in a moment.')).toBeTruthy()
  })

  it('lets a variable each person fills have no value of the pack’s', async () => {
    const user = userEvent.setup()
    PUT.mockReturnValue(new Promise(() => {}))
    const city = {
      name: 'city',
      value: 'Lisbon',
      description: null,
      perPerson: true,
      usedBy: ['items.get_item'],
    }
    show([city])
    expect(screen.getByText('Each person gives their own; Lisbon for someone who hasn’t.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Change city' }))
    await user.click(screen.getByRole('checkbox', { name: 'Leave it to each person' }))
    expect(screen.getByLabelText<HTMLInputElement>('Value').disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Save variable' }))
    expect(PUT.mock.calls[0]?.[1].body).toEqual({ variables: [{ name: 'city', value: null, description: null }] })
  })

  it('shows a variable with no value as each person’s own', () => {
    show([{ name: 'city', value: null, description: null, perPerson: true, usedBy: ['items.get_item'] }])
    expect(screen.getByText('each person’s own')).toBeTruthy()
    expect(screen.getByText('Each person gives their own; nothing for someone who hasn’t.')).toBeTruthy()
  })
})
