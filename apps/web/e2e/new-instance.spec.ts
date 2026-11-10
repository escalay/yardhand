/**
 * A brand-new instance, as its owner meets it: claim it with the setup code from the log, keep the owner key shown
 * once, then the guided setup on a page of its own: check the instance, connect the sample tools, give an agent a key
 * and watch its first call land, and finish on what to do next.
 */
import { expect, test } from '@playwright/test'
import { NEW_INSTANCE_CODE } from '../playwright.config'
import { signIn } from './demo'

test.describe.configure({ mode: 'serial' })

/** The owner key the claim showed, for the tests after it (each starts in a fresh browser). */
let ownerKey = ''

test('a new instance is claimed with its setup code, and shows the owner key once', async ({ page }) => {
  await page.goto('/app')
  await expect(page.getByRole('heading', { name: /Welcome to Yardhand/ })).toBeVisible()
  await page.getByLabel('Setup code').fill('AAAA-BBBB')
  await page.getByRole('button', { name: 'Claim this instance' }).click()
  await expect(page.getByRole('alert')).toContainText('docker compose logs gateway')

  // Typed loosely, as people do: lower case
  await page.getByLabel('Setup code').fill(NEW_INSTANCE_CODE.toLowerCase())
  await page.getByRole('button', { name: 'Claim this instance' }).click()
  await expect(page.getByRole('heading', { name: /This is your owner key/ })).toBeVisible()
  await expect(page.getByText(/^gw_owner_/)).toBeVisible()
  ownerKey = ((await page.getByText(/^gw_owner_/).textContent()) ?? '').trim()
  const go = page.getByRole('button', { name: 'Set up Yardhand' })
  await expect(go).toBeDisabled()
  await page.getByRole('checkbox', { name: 'I saved it in my password manager' }).check()
  await go.click()
  await expect(page).toHaveURL(/\/app\/setup\?step=instance/)
})

test('the guided setup has no tabs, and walks from the instance to an agent’s first call', async ({
  page,
  request,
}) => {
  await signIn(page, { ownerKey } as never)
  await page.goto('/app/setup')
  await expect(page.getByRole('navigation', { name: 'Places' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Setup steps' })).toBeVisible()

  // 1 · The instance: its address matches, its master key needs a copy
  await expect(page.getByRole('heading', { name: /Yardhand is running/ })).toBeVisible()
  await expect(page.getByText('Agents get the address you opened')).toBeVisible()
  await page.getByRole('link', { name: 'Connect a server' }).click()

  // 2 · A server: the sample tools, in one click
  await expect(page.getByRole('heading', { name: /Connect your first server/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect an agent' })).toBeDisabled()
  await page.getByRole('button', { name: 'Use the sample tools' }).click()
  await expect(page.getByText('Three sample tools are connected.')).toBeVisible()
  await expect(page.getByText('3 tools')).toBeVisible()
  await page.getByRole('link', { name: 'Connect an agent' }).click()

  // 3 · An agent: pick where it runs, make its key, paste, and its first call lands live
  await page.getByRole('radio', { name: 'Cursor' }).click()
  await expect(page.getByLabel('Name')).toHaveValue('Cursor on this machine')
  await page.getByRole('button', { name: 'Make its key' }).click()
  await expect(page.getByText('Paste this where Cursor runs')).toBeVisible()
  const key = /gw_[A-Za-z0-9_-]+/.exec((await page.locator('pre').first().textContent()) ?? '')?.[0] ?? ''
  expect(key).toMatch(/^gw_/)
  await expect(page.getByText(/Waiting for Cursor on this machine's first call/)).toBeVisible()
  const call = await request.post('/api/calls', {
    headers: { authorization: `Bearer ${key}`, 'x-gateway-via': 'mcp' },
    data: { tool: 'sample.roll_dice', arguments: { count: 2 } },
  })
  expect(call.status()).toBe(200)
  await expect(page.getByRole('heading', { name: /Cursor on this machine is connected/ })).toBeVisible()
  await page.getByRole('link', { name: 'Finish', exact: true }).click()

  // 4 · Ready: what is behind one address now, and the way into the app
  await expect(page.getByRole('heading', { name: /You’re set up/ })).toBeVisible()
  await expect(page.getByText(/1 server with 3 tools behind one address/)).toBeVisible()
  await page.getByRole('link', { name: /Go to the overview/ }).click()
  await expect(page.getByRole('navigation', { name: 'Places' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Guided setup' })).toBeVisible()
})

test('a second claim is refused once the instance has an owner', async ({ request }) => {
  const again = await request.post('/api/session/claim', { data: { code: NEW_INSTANCE_CODE } })
  expect(again.status()).toBe(409)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('every setup step fits the window', async ({ page }) => {
    await signIn(page, { ownerKey } as never)
    for (const step of ['instance', 'server', 'agent', 'done']) {
      await page.goto(`/app/setup?step=${step}`)
      await expect(page.locator('h1').first()).toBeVisible()
      await page.waitForTimeout(300)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow, `${step} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0)
    }
  })
})
