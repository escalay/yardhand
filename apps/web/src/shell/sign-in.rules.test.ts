import { describe, expect, it } from 'vitest'
import { approvalWaitingAt, nextAfterSignIn } from './sign-in.rules'

const ORIGIN = 'https://gw.example.com'
const at = (next: string) => `?next=${encodeURIComponent(next)}`

describe('after signing in', () => {
  it('sign-in follows next only to /oauth/authorize on this origin', () => {
    const authorize = '/oauth/authorize?response_type=code&client_id=client_abc&state=s'
    expect(nextAfterSignIn(at(authorize), ORIGIN)).toBe(authorize)
    expect(nextAfterSignIn(at(`${ORIGIN}${authorize}`), ORIGIN)).toBe(authorize)
    for (const elsewhere of [
      '//evil.example.test/oauth/authorize?x=1',
      '/\\evil.example.test/oauth/authorize?x=1',
      'https://evil.example.test/oauth/authorize?x=1',
      'javascript:alert(1)//oauth/authorize?',
      '/oauth/authorize',
      '/oauth/authorized?x=1',
      '/oauth/claim?claim_attempt_token=x',
      '/oauth/authorize/../../api/clients?x=1',
      '/app/settings',
      '',
    ])
      expect(nextAfterSignIn(at(elsewhere), ORIGIN), elsewhere).toBeNull()
    expect(nextAfterSignIn('', ORIGIN)).toBeNull()
  })

  it('reads next on the sign-in page only', () => {
    const search = at('/oauth/authorize?client_id=x')
    expect(approvalWaitingAt({ pathname: '/app/sign-in', search, origin: ORIGIN })).toBe('/oauth/authorize?client_id=x')
    expect(approvalWaitingAt({ pathname: '/app/settings', search, origin: ORIGIN })).toBeNull()
  })
})
