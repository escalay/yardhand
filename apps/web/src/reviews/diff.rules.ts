/** A line diff (longest common subsequence): what stayed, what went, what came. Small texts only: descriptions, schemas. */

export type DiffLine = { kind: 'same' | 'removed' | 'added'; text: string }

export const diffLines = (before: string, after: string): DiffLine[] => {
  const a = before.split('\n')
  const b = after.split('\n')
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      (lengths[i] as number[])[j] =
        a[i] === b[j]
          ? (lengths[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lengths[i + 1]?.[j] ?? 0, lengths[i]?.[j + 1] ?? 0)
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] as string })
      i++
      j++
    } else if ((lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0))
      lines.push({ kind: 'removed', text: a[i++] as string })
    else lines.push({ kind: 'added', text: b[j++] as string })
  }
  while (i < a.length) lines.push({ kind: 'removed', text: a[i++] as string })
  while (j < b.length) lines.push({ kind: 'added', text: b[j++] as string })
  return lines
}

/** JSON for diffing: keys sorted, two-space indent, so only real changes show. */
export const stableJson = (value: unknown): string => {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sort((item as Record<string, unknown>)[key])]),
          )
        : item
  return JSON.stringify(sort(value), null, 2)
}

/** Words that, in a tool description, try to steer the agent rather than describe the tool. */
const STEERING =
  /ignore (all |any )?(previous|prior|above) instructions|system prompt|you must|do not tell|always call|send .* to http/i

export const looksSteering = (text: string) => STEERING.test(text)
