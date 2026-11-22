import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSettled } from './useSettled'

describe('a settled value', () => {
  afterEach(() => vi.useRealTimers())

  it('follows the value only once it has rested', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ value }) => useSettled(value, 300), { initialProps: { value: 'a' } })
    rerender({ value: 'ab' })
    act(() => vi.advanceTimersByTime(200))
    rerender({ value: 'abc' })
    act(() => vi.advanceTimersByTime(200))
    expect(result.current).toBe('a')
    act(() => vi.advanceTimersByTime(100))
    expect(result.current).toBe('abc')
  })
})
