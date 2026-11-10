/** A fake embedder with a tiny vocabulary of concepts, so paraphrases land near each other without a network. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMeaningSearch } from '../../src/features/tools/meaning.js'
import { toolsRepo } from '../../src/features/tools/repo.js'
import type { Db } from '../../src/kit/index.js'
import { DIMENSIONS } from '../../src/kit/vectors/index.js'

const CONCEPTS = [
  /echo|repeat|parrot|say back|mirror/i,
  /shout|yell|loud|upper/i,
  /whisper|quiet/i,
  /item|lamp|thing/i,
  /flag|beta/i,
]

export const vectorOf = (text: string) => {
  // The kit's vector space reads rows of DIMENSIONS; the concepts use the first few
  const vector = new Float32Array(DIMENSIONS)
  CONCEPTS.forEach((concept, index) => {
    if (concept.test(text)) vector[index] = 1
  })
  vector[CONCEPTS.length] = 0.1
  const norm = Math.hypot(...vector)
  return vector.map((value) => value / norm)
}

/** Meaning search over the same database the app uses, embedding with `vectorOf`. */
export const fakeMeaning = (db: Db) => {
  let embedded = 0
  const search = createMeaningSearch({
    file: join(mkdtempSync(join(tmpdir(), 'meaning-')), 'tools.jsonl'),
    tools: toolsRepo(db),
    embed: async (inputs) => {
      embedded += inputs.length
      return { vectors: inputs.map((input) => vectorOf(String(input))), tokens: 0, cost: 0 }
    },
    query: async (q) => vectorOf(q),
    log: () => {},
  })
  return Object.assign(search, { embedded: () => embedded })
}
