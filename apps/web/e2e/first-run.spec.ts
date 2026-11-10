/**
 * The activation path on a fresh gateway, as the owner walks it: sign in, connect a server that needs a key, try one
 * of its tools, give an agent a key, watch that agent's first call land live, pin a tool, and see Home turn from the
 * checklist into the dashboard.
 */
import { expect, test } from '@playwright/test'
import { demoOf, signIn } from './demo'

const demo = () => demoOf(4471)

test.describe.configure({ mode: 'serial' })

test('refuses a wrong key and welcomes the owner', async ({ page }) => {
  await page.goto('/app')
  await expect(page.getByRole('heading', { name: /Sign in to Yardhand/ })).toBeVisible()
  await page.getByLabel('Owner key').fill('not-the-key-at-all')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('isn’t the owner key')
  await signIn(page, demo())
  await expect(page.getByRole('heading', { name: /Welcome to Yardhand/ })).toBeVisible()
  await expect(page.getByText('0 of 5 done')).toBeVisible()
})

test('the whole first-run path, to the first agent call', async ({ page, request }) => {
  const { mcp } = demo()
  await signIn(page, demo())

  // 1 · Connect a server: it asks for a key, gets one, shows its tools, goes live
  await page.getByRole('link', { name: 'Connect a server' }).click()
  await page.getByLabel('Address').fill(mcp.url)
  await page.getByRole('button', { name: 'Look' }).click()
  await expect(page.getByText('It asks for a key')).toBeVisible()
  await page.getByLabel('Key', { exact: true }).fill(mcp.token)
  await page.getByRole('button', { name: 'Look again with this key' }).click()
  await expect(page.getByText(/^MCP server · /)).toBeVisible()
  await expect(page.getByText('2 tools · 1 only read')).toBeVisible()
  await page.getByLabel('Id').fill('echo')
  await page.getByLabel('Title').fill('Echo')
  await page.getByRole('button', { name: 'Add connection' }).click()
  await expect(page.getByRole('heading', { name: /Echo is live/ })).toBeVisible()

  // 2 · Try one of its tools
  await page.getByRole('link', { name: /Try one of its tools/ }).click()
  await page.getByRole('link', { name: 'echo.echo' }).click()
  await page.getByLabel(/text/).fill('hello from the browser')
  await page.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByText('It answered')).toBeVisible()
  await expect(page.locator('pre', { hasText: 'hello from the browser' }).first()).toBeVisible()
  await expect(page.getByRole('tab', { name: 'curl' })).toBeVisible()

  // 3 · Give an agent a key: shown once, already in the setup to paste
  await page.goto('/app/agents/new')
  await page.getByLabel('Name').fill('Claude Code on test')
  await page.getByRole('button', { name: 'Make the key' }).click()
  await expect(page.getByText("Copy it now: you won't see it again")).toBeVisible()
  const key = (await page.locator('code').first().textContent())?.trim() ?? ''
  expect(key).toMatch(/^gw_/)
  await expect(page.locator('pre', { hasText: `Bearer ${key}` }).first()).toBeVisible()
  await expect(page.getByText(/Waiting for Claude Code on test's first call/)).toBeVisible()

  // 4 · The agent calls; the page sees it land, live
  const call = await request.post('/api/calls', {
    headers: { authorization: `Bearer ${key}`, 'x-gateway-via': 'mcp' },
    data: { tool: 'echo.echo', arguments: { text: 'from the agent' } },
  })
  expect(call.status()).toBe(200)
  await expect(page.getByRole('heading', { name: /Claude Code on test is connected/ })).toBeVisible()

  // 5 · Pin a tool, and Home becomes the dashboard
  await page.goto('/app/tools')
  await page.getByRole('button', { name: 'Pin echo.echo' }).click()
  await expect(page.getByRole('button', { name: 'Unpin echo.echo' })).toBeVisible()
  await page.goto('/app')
  await expect(page.getByRole('heading', { name: /2 tools from 1 server, one address/ })).toBeVisible()
  await expect(page.getByText('Latest calls')).toBeVisible()
})

test('an OAuth server is spotted, and asks for approval instead of a key', async ({ page }) => {
  await signIn(page, demo())
  await page.goto('/app/connections/new')
  await page.getByLabel('Address').fill(demo().oauth.url)
  await page.getByRole('button', { name: 'Look' }).click()
  await expect(page.getByText('MCP server · signs in with OAuth')).toBeVisible()
  await expect(page.getByLabel('Id')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add and sign in' })).toBeVisible()
})

test('⌘K finds a tool by what it does', async ({ page }) => {
  await signIn(page, demo())
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByPlaceholder(/Search tools by what they do/).fill('shouts')
  await page.getByRole('option', { name: /echo\.shout/ }).click()
  await expect(page).toHaveURL(/\/app\/tools\/echo\.shout$/)
  await expect(page.getByText('This changes something for real.')).toBeVisible()
})

test('a tool that changes things asks before running', async ({ page }) => {
  await signIn(page, demo())
  await page.goto('/app/tools/echo.shout')
  await page.getByLabel(/text/).fill('careful')
  await page.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByRole('alertdialog')).toContainText('Run echo.shout for real?')
  await page.getByRole('button', { name: 'Not now' }).click()
  await expect(page.getByText('It answered')).toHaveCount(0)
})

test('signing out ends the session', async ({ page }) => {
  await signIn(page, demo())
  await page.getByRole('button', { name: 'Owner menu' }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByLabel('Owner key')).toBeVisible()
})
