import { describe, expect, it } from 'vitest'
import { foundOf, pickPack, reachChangeOf, reachOf, repackable, waitingHint, withKey } from './agents.rules'

describe('agent rules', () => {
  it('puts the key in only when it is known', () => {
    expect(withKey('Bearer <YOUR_KEY> and <YOUR_KEY>', '<YOUR_KEY>', 'gw_1')).toBe('Bearer gw_1 and gw_1')
    expect(withKey('Bearer <YOUR_KEY>', '<YOUR_KEY>', null)).toBe('Bearer <YOUR_KEY>')
  })
  it('says an agent’s reach in words', () => {
    expect(reachOf({ upstreams: 'all', scope: 'write' })).toBe('Every connection, reads and changes')
    expect(reachOf({ upstreams: ['cookbook'], scope: 'read' })).toBe('1 connection, reads only')
  })
  it('says what to do while a new key waits for its first call', () => {
    expect(waitingHint('laptop')).toBe(
      'Paste the setup, then ask the agent to find and run one of your tools, say “find a tool in gw and run it”. It shows up here the moment it happens.',
    )
    // A pack's address is not a server named gw, and the owner is not the one who pastes the setup
    expect(waitingHint('Sam', { title: 'Loud' })).toBe(
      'Send Sam the message. Their first call to Loud shows up here the moment it happens.',
    )
  })
})

describe('finding tools', () => {
  it('says how many searches found something, and flags an agent that mostly doesn’t', () => {
    expect(foundOf({ searches7d: 11, found7d: 9 })).toEqual({ text: '9 of 11', struggling: false })
    expect(foundOf({ searches7d: 4, found7d: 1 })).toEqual({ text: '1 of 4', struggling: true })
    expect(foundOf({ searches7d: 2, found7d: 0 }).struggling).toBe(false)
    expect(foundOf({ searches7d: 0, found7d: 0 }).text).toBe('–')
  })

  it('picks packs for a key, moving the default only when it goes', () => {
    const one = pickPack({ packs: [], pack: '' }, 'work', true)
    expect(one).toEqual({ packs: ['work'], pack: 'work' })
    const two = pickPack(one, 'design', true)
    expect(two).toEqual({ packs: ['work', 'design'], pack: 'work' })
    expect(pickPack(two, 'work', false)).toEqual({ packs: ['design'], pack: 'design' })
    expect(pickPack(two, 'design', false)).toEqual({ packs: ['work'], pack: 'work' })
    expect(reachOf({ upstreams: [], scope: 'read', pack: 'work', packs: ['work', 'design'] })).toBe(
      '2 packs (work by default), reads only',
    )
  })
})

describe('changing what an agent reaches', () => {
  const choice = {
    scope: 'read' as const,
    packChoice: { packs: ['desk', 'loud'], pack: 'desk' },
    everything: false,
    chosen: ['sample'],
  }

  it('lets a pack key change its packs, never an app that signed in at a pack’s address', () => {
    expect(repackable({ kind: 'key', pack: 'desk' })).toBe(true)
    expect(repackable({ kind: 'oauth', pack: 'desk' })).toBe(false)
    expect(repackable({ kind: 'key', pack: null })).toBe(false)
    expect(repackable({ kind: 'oauth', pack: null })).toBe(false)
  })

  it('sends a pack key’s packs, an app locked to a pack its scope alone, and anyone else’s connections', () => {
    expect(reachChangeOf({ kind: 'key', pack: 'desk' }, choice)).toEqual({
      scope: 'read',
      packs: ['desk', 'loud'],
      pack: 'desk',
    })
    expect(reachChangeOf({ kind: 'oauth', pack: 'desk' }, choice)).toEqual({ scope: 'read' })
    expect(reachChangeOf({ kind: 'oauth', pack: null }, choice)).toEqual({ scope: 'read', upstreams: ['sample'] })
    expect(reachChangeOf({ kind: 'key', pack: null }, { ...choice, everything: true })).toEqual({
      scope: 'read',
      upstreams: 'all',
    })
  })
})
