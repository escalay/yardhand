/**
 * The sign-in log (phase 0 of OAuth on the kit, kept until 0.7.0): one line on stdout per registration, consent page
 * and token request, saying what the app sent: its name, how it is known (registered here, or a client_id URL), the
 * resource it named, where it returns to, Sec-Fetch-Site and the Referer's origin, and the address that registered.
 * Never a code, verifier, token, state, ticket, cookie or client_id: each line is built from named fields only.
 */
import { createHash } from 'node:crypto'
import type { OAuthStore } from '../../kit/index.js'

type Fetch = (request: Request, ...rest: never[]) => Response | Promise<Response>
type Step = 'register' | 'authorize' | 'token'

const STEPS: Record<string, { method: string; step: Step }> = {
  '/oauth/register': { method: 'POST', step: 'register' },
  '/oauth/authorize': { method: 'GET', step: 'authorize' },
  '/oauth/token': { method: 'POST', step: 'token' },
}
const SITES = new Set(['same-origin', 'same-site', 'cross-site', 'none'])
const quoted = (text: string) => JSON.stringify(text.slice(0, 200))
/** At most five of a list an app sent, and how many more. */
const listed = (values: string[]) =>
  values.slice(0, 5).join(',') + (values.length > 5 ? ` and ${values.length - 5} more` : '')

/** A short id that ties one app's lines together without writing its client_id. */
const idOf = (clientId: string) => createHash('sha256').update(clientId).digest('hex').slice(0, 8)

/** Where a URL leads, as scheme and host: an app's own scheme (`cursor://`) keeps its name. */
const placeOf = (value: string | null | undefined) => {
  if (!value) return 'absent'
  if (!URL.canParse(value)) return 'unreadable'
  const url = new URL(value)
  return url.host ? `${url.protocol}//${url.host}` : url.protocol
}

/**
 * A resource as sent; one with a query, a fragment or a user and password only by its origin and path, since those
 * could carry anything.
 */
const resourceOf = (values: string[]) => {
  if (!values.length) return 'none'
  return listed(
    values.map((value) => {
      if (!URL.canParse(value)) return '"not a URL"'
      const url = new URL(value)
      const cut = url.search || url.hash || url.username || url.password
      return cut ? `${quoted(url.origin + url.pathname)} (cut to origin and path)` : quoted(value)
    }),
  )
}

const browserOf = (request: Request) => {
  const site = request.headers.get('sec-fetch-site')
  const said = site === null ? 'absent' : SITES.has(site) ? site : 'other'
  return `sec-fetch-site=${said} referer=${placeOf(request.headers.get('referer'))}`
}

/** The address that sent a request, as the proxy in front or the socket says: an IP address, or `unreadable`. */
const addressOf = (request: Request, rest: unknown[]) => {
  const address =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    (rest[0] as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress
  if (!address) return 'unknown'
  return /^[0-9a-fA-F:.]{2,45}$/.test(address) ? address : 'unreadable'
}

const jsonOf = (message: Request | Response) =>
  message
    .clone()
    .json()
    .catch(() => ({})) as Promise<Record<string, unknown>>

/** A token request's fields, form or JSON, as strings; a JSON list is each of its strings. */
const formOf = async (request: Request) => {
  if ((request.headers.get('content-type') ?? '').includes('json'))
    return new URLSearchParams(
      Object.entries(await jsonOf(request)).flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value]).flatMap((one) => (typeof one === 'string' ? [[key, one]] : [])),
      ),
    )
  return new URLSearchParams(await request.clone().text())
}

/** Wraps the app's fetch, outermost, so a line sees the request as the app sent it. */
export const signInLog = ({
  store,
  log = (line: string) => console.log(line),
}: {
  store: OAuthStore
  log?: (line: string) => void
}) => {
  const clientOf = async (clientId: string | null) => {
    if (!clientId) return 'client=none'
    const client = await store.get('client', clientId)
    const by = client ? 'dcr' : /^https:\/\//.test(clientId) ? 'url' : 'unknown'
    return `client=${client ? quoted(String(client.name)) : 'unknown'} by=${by} id=${idOf(clientId)}`
  }
  const register = async (request: Request, answer: Response, rest: unknown[]) => {
    const { client_name: name, redirect_uris: uris } = await jsonOf(request)
    const { client_id: made } = await jsonOf(answer)
    const callbacks = Array.isArray(uris) ? listed(uris.map((uri) => placeOf(String(uri)))) : 'none'
    return `client=${typeof name === 'string' ? quoted(name) : 'none'}${typeof made === 'string' ? ` id=${idOf(made)}` : ''} callbacks=${callbacks} address=${addressOf(request, rest)}`
  }
  const authorize = async (request: Request) => {
    const sent = new URL(request.url).searchParams
    const hop = sent.get('hop') === '1' ? ' hop=1' : ''
    return `${await clientOf(sent.get('client_id'))} resource=${resourceOf(sent.getAll('resource'))} callback=${placeOf(sent.get('redirect_uri'))} ${browserOf(request)}${hop}`
  }
  const token = async (request: Request) => {
    const sent = await formOf(request)
    const grant = sent.get('grant_type') ?? ''
    const returns = sent.has('redirect_uri') ? `sent callback=${placeOf(sent.get('redirect_uri'))}` : 'absent'
    return `grant=${/^[\w:.-]{1,100}$/.test(grant) ? grant : quoted(grant)} ${await clientOf(sent.get('client_id'))} resource=${resourceOf(sent.getAll('resource'))} redirect_uri=${returns} ${browserOf(request)}`
  }
  return (fetch: Fetch): Fetch =>
    async (request: Request, ...rest: never[]) => {
      const known = STEPS[new URL(request.url).pathname]
      if (!known || known.method !== request.method) return fetch(request, ...rest)
      // Read before the kit does: what it reads is gone from the request
      const copy = request.bodyUsed ? null : request.clone()
      const answer = await fetch(request, ...rest)
      const fields = !copy
        ? Promise.reject()
        : known.step === 'register'
          ? register(copy, answer, rest)
          : known.step === 'authorize'
            ? authorize(copy)
            : token(copy)
      // A line that can't be written never stands in the way of a sign-in, and says nothing of why
      log(`sign-in ${known.step} ${answer.status}: ${await fields.catch(() => 'not logged')}`)
      return answer
    }
}
