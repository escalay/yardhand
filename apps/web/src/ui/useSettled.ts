/** A value once it has stopped changing for `ms`: what a query asks for while someone types. */
import { useEffect, useState } from 'react'

export const useSettled = <Value>(value: Value, ms = 200) => {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}
