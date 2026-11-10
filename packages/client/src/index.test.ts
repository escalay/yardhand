import { describe, expect, it } from 'vitest'
import { createGateway, GatewayError, textOf } from './index.js'

const fakeFetch = (answers: Record<string, { status: number; body: unknown }>, seen: Request[] = []) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    seen.push(request)
    const url = new URL(request.url)
    const answer = answers[`${request.method} ${url.pathname}`] ?? {
      status: 404,
      body: { title: 'Not found', status: 404 },
    }
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

describe('gateway client', () => {
  it('runs a tool with the key and returns its result', async () => {
    const seen: Request[] = []
    const gateway = createGateway({
      key: 'k',
      url: 'https://gateway.test',
      fetch: fakeFetch(
        {
          'POST /api/calls': {
            status: 200,
            body: {
              id: 'call_1',
              tool: 'x.echo',
              status: 'ok',
              durationMs: 3,
              result: { content: [{ type: 'text', text: 'hi' }] },
            },
          },
        },
        seen,
      ),
    })
    const result = await gateway.call('x.echo', { text: 'hi' })
    expect(textOf(result)).toBe('hi')
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer k')
    expect(await seen[0]?.json()).toEqual({ tool: 'x.echo', arguments: { text: 'hi' } })
  })

  it('throws problems as GatewayError with the details', async () => {
    const gateway = createGateway({
      key: 'k',
      url: 'https://gateway.test',
      fetch: fakeFetch({
        'POST /api/calls': {
          status: 400,
          body: {
            title: 'Bad request',
            status: 400,
            detail: 'arguments.text is required',
            errors: [{ path: 'arguments.text', message: 'is required' }],
          },
        },
      }),
    })
    const failure = await gateway.call('x.echo', {}).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GatewayError)
    expect((failure as GatewayError).problem.errors?.[0]?.path).toBe('arguments.text')
  })

  it('searches with the query in the URL', async () => {
    const seen: Request[] = []
    const gateway = createGateway({
      key: 'k',
      url: 'https://gateway.test',
      fetch: fakeFetch({ 'GET /api/tools': { status: 200, body: { _embedded: { tools: [{ name: 'a.b' }] } } } }, seen),
    })
    expect((await gateway.tools.search('find notes', { limit: 3 })).map((tool) => tool.name)).toEqual(['a.b'])
    expect(new URL(seen[0]!.url).search).toBe('?q=find+notes&limit=3')
  })
})
