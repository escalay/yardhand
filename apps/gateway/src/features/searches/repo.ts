/** The search log: the only queries on it. */
import { randomUUID } from 'node:crypto'
import { and, desc, gte, lt, ne } from 'drizzle-orm'
import type { Db } from '../../kit/index.js'
import { type SearchRow, searches } from './schema.js'

export const normalize = (query: string) => query.trim().toLowerCase().replace(/\s+/g, ' ')

export const searchesRepo = (db: Db) => ({
  record: ({ tools, ...row }: Omit<SearchRow, 'id' | 'createdAt' | 'normalized' | 'tools'> & { tools: string[] }) =>
    db.insert(searches).values({
      ...row,
      tools: JSON.stringify(tools.slice(0, 20)),
      id: `srch_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      normalized: normalize(row.query),
      createdAt: new Date().toISOString(),
    }),
  /** Agents' searches since a moment (not the owner trying things in the app), newest first. */
  since: (since: string, limit = 1000) =>
    db
      .select()
      .from(searches)
      .where(and(gte(searches.createdAt, since), ne(searches.via, 'app')))
      .orderBy(desc(searches.createdAt))
      .limit(limit),
  prune: (before: string) => db.delete(searches).where(lt(searches.createdAt, before)),
})

export type SearchesRepo = ReturnType<typeof searchesRepo>
