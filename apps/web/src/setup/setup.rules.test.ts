import { describe, expect, it } from 'vitest'
import { checksOf, doneOf, firstOpen } from './setup.rules'

const IDS = ['connect', 'try', 'key', 'first-call', 'pin'] as const
const setup = (done: string[]) => ({
  steps: IDS.map((id) => ({
    id,
    title: id,
    href: '',
    done: done.includes(id),
  })),
  done: done.length,
  total: 5,
  complete: done.length === 5,
  next: null,
})
const system = {
  publicOrigin: 'http://localhost:8080',
  keys: { masterKey: 'file' as const },
  features: { meaningSearch: false, traces: false, access: false, oauth: true, alerts: false },
  jobs: [],
}

describe('the setup', () => {
  it('opens on the first step not done yet', () => {
    expect(firstOpen(doneOf(setup([]), []))).toBe('instance')
    expect(firstOpen(doneOf(setup([]), ['instance']))).toBe('server')
    expect(firstOpen(doneOf(setup(['connect', 'try']), []))).toBe('agent')
    expect(firstOpen(doneOf(setup(['connect', 'key', 'first-call']), []))).toBe('done')
  })

  it('looks at the address, the transport, the master key and the backups', () => {
    const local = checksOf(system, 'http://localhost:8080')
    expect(local.map((check) => [check.id, check.tone])).toEqual([
      ['address', 'ok'],
      ['https', 'ok'],
      ['keys', 'warn'],
      ['backups', 'ok'],
    ])
    const lan = checksOf(system, 'http://nas.local:8080')
    expect(lan[0]).toMatchObject({ tone: 'warn' })
    expect(lan[0]?.body).toContain('PUBLIC_HOST=http://nas.local:8080')
    expect(lan[1]).toMatchObject({ id: 'https', tone: 'warn' })
    const behindTls = checksOf(
      { ...system, publicOrigin: 'https://yard.example.test', keys: { masterKey: 'env' } },
      'https://yard.example.test',
    )
    expect(behindTls.every((check) => check.tone === 'ok')).toBe(true)
  })
})
