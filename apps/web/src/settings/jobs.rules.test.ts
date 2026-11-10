import { describe, expect, it } from 'vitest'
import { backupKind, holdsLine, nextLine, versionLine } from './jobs.rules'

describe('scheduled jobs', () => {
  it('says when the next run is due', () => {
    const now = new Date('2026-11-10T12:00:00Z').getTime()
    expect(nextLine('2026-11-10T12:57:00Z', now)).toBe('next in 57 min')
    expect(nextLine('2026-11-11T09:00:00Z', now)).toBe('next in 21 h')
    expect(nextLine('2026-11-10T11:00:00Z', now)).toBe('due now')
  })

  it('shows the build beside the version when the image carries one', () => {
    expect(versionLine('0.1.0', '8275d963ebb7')).toBe('0.1.0 · 8275d96')
    expect(versionLine('0.1.0', '8275d963ebb7-dirty')).toBe('0.1.0 · 8275d96 (uncommitted)')
    expect(versionLine('0.1.0', null)).toBe('0.1.0')
  })

  it('says what a backup file is and what it holds', () => {
    expect(backupKind('state-2026-11-10.sqlite')).toBe('Daily backup')
    expect(backupKind('before-restore-20261110T173000Z.sqlite')).toBe('Kept before a restore')
    expect(backupKind('before-0.2.0.sqlite')).toBe('Kept before upgrading to 0.2.0')
    expect(holdsLine({ connections: 3, tools: 40, agents: 1 })).toBe('It holds 3 connections, 40 tools and 1 agent.')
  })
})
