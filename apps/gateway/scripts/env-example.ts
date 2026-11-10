/** Writes `deploy/compose/.env.example` from the list of settings in `src/env.ts` (a test fails when it is stale). */
import { writeFileSync } from 'node:fs'
import { EXAMPLE_HEADER, renderEnv } from '../src/env.js'

writeFileSync(new URL('../../../deploy/compose/.env.example', import.meta.url), renderEnv({}, EXAMPLE_HEADER))
