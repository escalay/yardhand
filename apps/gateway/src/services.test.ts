import { describe, expect, it } from 'vitest'
import { publicOriginOf } from './services.js'

describe('the public address', () => {
  it('reads PUBLIC_HOST as a name over HTTPS, or as a whole address when it has a scheme', () => {
    expect(publicOriginOf('gateway.example.test')).toBe('https://gateway.example.test')
    expect(publicOriginOf('http://nas.local:8080/')).toBe('http://nas.local:8080')
    expect(publicOriginOf('https://gateway.example.test')).toBe('https://gateway.example.test')
    expect(publicOriginOf(undefined)).toBe('http://localhost:4400')
    expect(publicOriginOf('')).toBe('http://localhost:4400')
  })
})
