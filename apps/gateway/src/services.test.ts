import { describe, expect, it } from 'vitest'
import { publicOriginOf, statedOriginOf } from './services.js'

describe('the public address', () => {
  it('reads PUBLIC_HOST as a name over HTTPS, or as a whole address when it has a scheme', () => {
    expect(publicOriginOf('gateway.example.test')).toBe('https://gateway.example.test')
    expect(publicOriginOf('http://nas.local:8080/')).toBe('http://nas.local:8080')
    expect(publicOriginOf('https://gateway.example.test')).toBe('https://gateway.example.test')
    expect(publicOriginOf(undefined)).toBe('http://localhost:4400')
    expect(publicOriginOf('')).toBe('http://localhost:4400')
  })

  it('takes PUBLIC_HOST as the address for people only when someone else can reach it', () => {
    expect(statedOriginOf('gw.example.com')).toBe('https://gw.example.com')
    expect(statedOriginOf('http://nas.local:8080')).toBe('http://nas.local:8080')
    expect(statedOriginOf(undefined)).toBeNull()
    expect(statedOriginOf('')).toBeNull()
    // The compose file's default, and other names of this machine alone
    for (const own of ['http://localhost:8080', 'localhost', 'http://127.0.0.1:4400', 'http://[::1]:8080'])
      expect([own, statedOriginOf(own)]).toEqual([own, null])
  })
})
