/** Where a demo gateway's fake upstreams listen, and signing in as its owner. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BrowserContext, expect, type Page } from '@playwright/test'

export type Demo = {
  ownerKey: string
  mcp: { url: string; token: string }
  rest: { url: string; key: string }
  oauth: { url: string }
}

export const demoOf = (port: number): Demo =>
  JSON.parse(readFileSync(join(import.meta.dirname, `.demo-${port}.json`), 'utf8'))

/** Session cookies by owner key: sign-in allows 10 a minute, so a suite signs in once and reuses the session. */
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['cookies']>>>()

export const signIn = async (page: Page, demo: Demo) => {
  const kept = sessions.get(demo.ownerKey)
  if (kept) await page.context().addCookies(kept)
  await page.goto('/app')
  const signedIn = page.getByRole('button', { name: /Find anything/ }).filter({ visible: true })
  const form = page.getByLabel('Owner key')
  await expect(signedIn.or(form)).toBeVisible()
  if (await form.isVisible()) {
    await form.fill(demo.ownerKey)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }
  await expect(signedIn).toBeVisible()
  sessions.set(demo.ownerKey, await page.context().cookies())
}
