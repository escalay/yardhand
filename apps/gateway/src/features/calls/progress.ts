/**
 * Where an upstream's progress goes while a call runs. The MCP layer sets it around a call (the agent asked for
 * progress with a token); the pipeline reports into it. In-process route calls keep the async context, so it reaches.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Progress } from '../../adapters/index.js'

export const progressSink = new AsyncLocalStorage<(progress: Progress) => void>()
