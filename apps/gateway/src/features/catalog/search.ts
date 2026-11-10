import { STOP } from '../tools/words.js'

/** When a catalog match is good enough to put in front of an agent: it shares at least half the asked words. */

const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2 && !STOP.has(word))

/** Each asked word counts when a word of the text starts with it (or it with that word: "recipes" ~ "recipe"). */
export const matchesEnough = (asked: string, text: string) => {
  const wanted = [...new Set(wordsOf(asked))]
  if (!wanted.length) return false
  const have = wordsOf(text)
  const hits = wanted.filter((word) => have.some((own) => own.startsWith(word) || word.startsWith(own))).length
  return hits >= Math.ceil(wanted.length / 2)
}
