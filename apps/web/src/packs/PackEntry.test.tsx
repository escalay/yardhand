import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type Schemas } from '@/api/client'
import { EntryEditor } from './PackEntry'

vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  api: { GET: vi.fn(), PATCH: vi.fn() },
}))

type PackTool = Schemas['PackTool']

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

const schema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Which item.' },
    verbose: { type: 'boolean' },
    limit: { type: 'integer', default: 10 },
  },
  required: ['id', 'limit'],
}

const toolOf = (over: Partial<PackTool> = {}): PackTool => ({
  name: 'items.get_item',
  tool: 'items.get_item',
  alias: null,
  fixed: {},
  defaults: { limit: '{{page_size}}' },
  inputs: [
    {
      name: 'id',
      mode: 'agent',
      value: null,
      resolved: null,
      required: true,
      problem: null,
      note: null,
      unchecked: false,
    },
    {
      name: 'verbose',
      mode: 'agent',
      value: null,
      resolved: null,
      required: false,
      problem: null,
      note: null,
      unchecked: false,
    },
    {
      name: 'limit',
      mode: 'default',
      value: '{{page_size}}',
      resolved: 5,
      required: true,
      problem: null,
      note: null,
      unchecked: false,
    },
  ],
  lostInputs: [],
  upstream: 'items',
  title: 'One item',
  description: 'One item',
  upstreamDescription: 'One item',
  wording: null,
  reason: 'picked',
  via: null,
  needsWrite: false,
  live: true,
  flag: null,
  ...over,
})

const variables = [{ name: 'page_size', value: 5, description: null, usedBy: ['items.get_item'] }]

const GET = vi.mocked(api.GET) as unknown as ReturnType<typeof vi.fn>
const PATCH = vi.mocked(api.PATCH) as unknown as ReturnType<typeof vi.fn>

const show = (tool = toolOf(), onDone = vi.fn()) => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <EntryEditor
        pack="loud"
        tool={tool}
        mode="edit"
        taken={new Set([tool.name])}
        variables={variables}
        onDone={onDone}
      />
    </QueryClientProvider>,
  )
  return { onDone }
}

const modesOf = (input: string) => screen.findByRole('radiogroup', { name: `Who fills ${input}` })
const checked = (group: HTMLElement) => within(group).getByRole('radio', { checked: true })

describe('the inputs of a pack tool', () => {
  beforeEach(() => {
    GET.mockResolvedValue(answer({ name: 'items.get_item', inputSchema: schema }))
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('says it is reading the tool’s inputs until they are there', async () => {
    GET.mockReturnValue(new Promise(() => {}))
    show()
    expect(screen.getByText('Reading items.get_item’s inputs…')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
  })

  it('says why the inputs can’t be read, and what to do', async () => {
    GET.mockResolvedValue(problem(503, { detail: 'items is not answering' }))
    show()
    expect(
      await screen.findByText(
        'Can’t read items.get_item’s inputs: items is not answering. Sync its connection and try again.',
      ),
    ).toBeTruthy()
  })

  it('says a tool takes no inputs', async () => {
    GET.mockResolvedValue(answer({ name: 'items.get_item', inputSchema: { type: 'object', properties: {} } }))
    show(toolOf({ defaults: {}, inputs: [] }))
    expect(await screen.findByText('It takes no inputs.')).toBeTruthy()
  })

  it('shows who fills each input, the value as written and as sent, and that every value fits', async () => {
    show()
    expect(checked(await modesOf('limit')).getAttribute('value')).toBe('default')
    expect(checked(await modesOf('id')).getAttribute('value')).toBe('agent')
    expect(screen.getByLabelText<HTMLInputElement>('Value of limit').value).toBe('{{page_size}}')
    expect(screen.getByText('Sent as 5.')).toBeTruthy()
    expect(screen.getByText('Shown with this value; the agent may send another.')).toBeTruthy()
    expect(screen.queryByLabelText('Value of id')).toBeNull()
    expect(screen.getByText('✓ Every value fits the tool’s current schema')).toBeTruthy()
    // Per person comes with its own pull request: no control for it here
    expect(screen.queryByRole('radio', { name: /per person/i })).toBeNull()
  })

  it('marks a value the tool no longer takes, and an input it dropped', async () => {
    show(
      toolOf({
        fixed: { colour: 'red' },
        lostInputs: ['colour'],
        inputs: toolOf().inputs.map((input) =>
          input.name === 'limit' ? { ...input, problem: 'limit must be integer' } : input,
        ),
      }),
    )
    await modesOf('limit')
    expect(screen.getByText('limit must be integer. Calls fail until you change the value.')).toBeTruthy()
    expect(screen.getByText(/items\.get_item no longer takes it\. Saving drops it from this pack\./)).toBeTruthy()
    expect(screen.getByText('2 values don’t fit the tool’s current schema: change them and save.')).toBeTruthy()
    expect(screen.queryByText(/Every value fits/)).toBeNull()
  })

  it('says a value was not checked, where the gateway could not read the input’s schema, and claims no fit', async () => {
    show(
      toolOf({
        inputs: toolOf().inputs.map((input) =>
          input.name === 'limit'
            ? { ...input, note: 'limit is not checked: its schema can’t be read here', unchecked: true }
            : input,
        ),
      }),
    )
    await modesOf('limit')
    expect(
      screen.getByText('limit was not checked: the gateway can’t read its schema, so only a call checks it.'),
    ).toBeTruthy()
    expect(screen.queryByText(/Every value fits/)).toBeNull()
  })

  it('says a word between braces that is no variable is sent as written', async () => {
    const user = userEvent.setup()
    show()
    await user.click(within(await modesOf('id')).getByRole('radio', { name: 'Fixed' }))
    await user.type(screen.getByLabelText('Value of id'), '{{{{first_name}}')
    expect(screen.getByText('No variable first_name: sent as written.')).toBeTruthy()
  })

  it('saves the name, what is fixed and what is a default together', async () => {
    const user = userEvent.setup()
    PATCH.mockResolvedValue(answer(toolOf()))
    const { onDone } = show()
    await user.click(within(await modesOf('id')).getByRole('radio', { name: 'Fixed' }))
    expect(screen.getByText('Filled on every call and hidden from the pack’s keys.')).toBeTruthy()
    await user.type(screen.getByLabelText('Value of id'), '42')
    // Unsaved values are not said to fit: the gateway checks them on save
    expect(screen.queryByText(/Every value fits/)).toBeNull()
    await user.click(within(await modesOf('verbose')).getByRole('radio', { name: 'Default' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(PATCH).toHaveBeenCalledWith('/api/packs/{name}/tools/{tool}', {
      params: { path: { name: 'loud', tool: 'items.get_item' } },
      body: { alias: null, fixed: { id: '42' }, defaults: { verbose: false, limit: '{{page_size}}' } },
    })
  })

  it('puts a refused value beside its input, and stays open', async () => {
    const user = userEvent.setup()
    PATCH.mockResolvedValue(
      problem(400, {
        detail: 'Not saved: limit must be integer. GET /api/tools/{name} shows each tool’s inputs.',
        errors: [{ path: 'tools.items.get_item.defaults.limit', message: 'limit must be integer' }],
      }),
    )
    const { onDone } = show()
    await modesOf('limit')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('limit must be integer.')).toBeTruthy()
    expect(screen.getByText('Not saved: change the values marked above.')).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
  })
})
