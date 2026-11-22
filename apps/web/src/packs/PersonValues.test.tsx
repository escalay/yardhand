import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type Person } from '@/api/client'
import { ValuesDialog } from './PersonValues'
import { personalFields } from './packs.rules'

vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  api: { PUT: vi.fn() },
}))

const PUT = vi.mocked(api.PUT) as unknown as ReturnType<typeof vi.fn>
const answer = (data: unknown) => ({ data, response: { ok: true, status: 200 } })

// A number and a yes or no the pack has no value of: the kind is the one its inputs take
const fields = personalFields({
  variables: [
    { name: 'days', value: null, description: null, perPerson: true, kind: 'number' },
    { name: 'loud', value: null, description: null, perPerson: true, kind: 'boolean' },
  ],
})

const show = (values: Person['values']) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ValuesDialog
        pack="loud"
        person={{ id: 'cl_sam', name: 'Sam', values } as unknown as Person}
        fields={fields}
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>,
  )

describe('a person’s values, changed from their row under People', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('saves a number and a yes or no back as they were set, though the pack has no value of them', async () => {
    const user = userEvent.setup()
    PUT.mockResolvedValue(answer({}))
    show({ days: 3, loud: true })
    await user.click(screen.getByRole('button', { name: 'Save values' }))
    await waitFor(() => expect(PUT).toHaveBeenCalled())
    expect(PUT).toHaveBeenCalledWith('/api/packs/{name}/people/{client}/values', {
      params: { path: { name: 'loud', client: 'cl_sam' } },
      body: { values: { days: 3, loud: true } },
    })
  })

  it('reads a changed number as a number', async () => {
    const user = userEvent.setup()
    PUT.mockResolvedValue(answer({}))
    show({ days: 3 })
    await user.clear(screen.getByLabelText('days'))
    await user.type(screen.getByLabelText('days'), '5')
    await user.type(screen.getByLabelText('loud'), 'false')
    await user.click(screen.getByRole('button', { name: 'Save values' }))
    await waitFor(() => expect(PUT).toHaveBeenCalled())
    expect(PUT.mock.calls[0]?.[1].body).toEqual({ values: { days: 5, loud: false } })
  })
})
