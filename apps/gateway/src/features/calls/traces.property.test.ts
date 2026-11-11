import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseTraceparent } from './traces.js'

const hex = (length: number) => fc.stringMatching(new RegExp(`^[0-9a-f]{${length}}$`))

describe('parseTraceparent, for any header a caller sends', () => {
  it('gives ids of the right shape, or null', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary' }), fc.constant(null), fc.constant(undefined)), (header) => {
        const parent = parseTraceparent(header)
        if (parent) {
          expect(parent.traceId).toMatch(/^[0-9a-f]{32}$/)
          expect(parent.parentId).toMatch(/^[0-9a-f]{16}$/)
        }
      }),
    )
  })

  it('reads every well-formed header, in any case and with spaces around it', () => {
    fc.assert(
      fc.property(hex(32), hex(16), hex(2), fc.boolean(), (traceId, parentId, flags, upper) => {
        fc.pre(!/^0+$/.test(traceId) && !/^0+$/.test(parentId))
        const header = `00-${traceId}-${parentId}-${flags}`
        expect(parseTraceparent(` ${upper ? header.toUpperCase() : header} `)).toEqual({ traceId, parentId })
      }),
    )
  })
})
