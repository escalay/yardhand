/**
 * The browser tests: the built app against demo gateways with fake upstreams on local ports. One starts empty (the
 * first-run path end to end), one starts with a week of use (reviews, activity), and one has no owner yet (claiming
 * it, then the guided setup). `pnpm e2e` builds first.
 */
import { defineConfig, devices } from '@playwright/test'

/** The setup code of the gateway that starts with no owner (new-instance.spec.ts). */
export const NEW_INSTANCE_CODE = 'TEST-2345'

const gateway = (port: number, seed: boolean, setupCode?: string) => ({
  command: `pnpm --dir ../gateway exec tsx scripts/demo.ts${seed ? ' --seed' : ''}`,
  url: `http://127.0.0.1:${port}/api/health`,
  env: {
    PORT: String(port),
    WEB_DIR: `${import.meta.dirname}/dist`,
    DEMO_INFO_FILE: `${import.meta.dirname}/e2e/.demo-${port}.json`,
    ...(setupCode ? { DEMO_SETUP_CODE: setupCode } : {}),
  },
  reuseExistingServer: false,
  timeout: 60_000,
})

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  projects: [
    // in-use runs serially against one seeded gateway: a retry would replay it over state the first try changed
    { name: 'first-run', testMatch: /first-run\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:4471' } },
    { name: 'in-use', testMatch: /in-use\.spec\.ts/, retries: 0, use: { baseURL: 'http://127.0.0.1:4472' } },
    { name: 'new-instance', testMatch: /new-instance\.spec\.ts/, use: { baseURL: 'http://localhost:4473' } },
  ],
  webServer: [gateway(4471, false), gateway(4472, true), gateway(4473, false, NEW_INSTANCE_CODE)],
})
