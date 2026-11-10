/**
 * The way back from a lost owner key: forgets the owner who claimed this instance, so its next start prints a new
 * setup code and the browser asks for it again. Connections, agents and data stay as they are.
 *
 * @example
 * docker compose run --rm -e GATEWAY_SCRIPT=scripts/reset-owner.ts gateway && docker compose restart gateway
 */
import { resetOwner } from '../src/features/instance/keys.js'

resetOwner(process.env.STATE_DIR ?? '.state')
console.log(
  'The owner is forgotten. Restart the gateway, then open the app: it asks for the new setup code in the log.',
)
