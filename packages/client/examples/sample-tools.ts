/**
 * Rolls dice with the sample tools, through Yardhand with no MCP client.
 *   YARDHAND_URL=http://localhost:8080 YARDHAND_KEY=… pnpm tsx examples/sample-tools.ts
 */
import { createGateway, GatewayError, textOf } from '../src/index.ts'

const gateway = createGateway({
  url: process.env.YARDHAND_URL ?? 'http://localhost:8080',
  key: process.env.YARDHAND_KEY ?? '',
})

try {
  const result = await gateway.call('sample.roll_dice', { count: 2, sides: 6 })
  console.log(textOf(result))
} catch (error) {
  if (error instanceof GatewayError)
    console.error(`${error.problem.status} ${error.problem.detail ?? error.problem.title}`)
  else throw error
  process.exitCode = 1
}
