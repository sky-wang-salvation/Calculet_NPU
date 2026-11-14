import { setTimeout as delay } from 'node:timers/promises'
import { BridgeError, identifier } from './protocol.js'

export interface PollResult<T> {
  jobId: string
  completed: boolean
  timedOut: boolean
  elapsedMs: number
  job?: T
  queryError?: { code: string; message: string }
}

export async function pollJob<T>(options: {
  jobId: string
  signal: AbortSignal
  maxWaitMs: number
  pollIntervalMs: number
  ensureConfigured: () => void
  query: (signal: AbortSignal) => Promise<T>
  sameIdentity: (previous: T, next: T) => boolean
  terminal: (job: T) => boolean
}): Promise<PollResult<T>> {
  const { jobId, signal, maxWaitMs, pollIntervalMs } = options
  identifier(jobId)
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 60000
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 10000) {
    throw new BridgeError('INVALID_REQUEST', 'maxWaitMs must be 1–60000; pollIntervalMs must be 10–10000 milliseconds.')
  }
  signal.throwIfAborted()
  options.ensureConfigured()
  const started = performance.now()
  const deadline = AbortSignal.timeout(maxWaitMs)
  const combined = AbortSignal.any([signal, deadline])
  let job: T | undefined
  const result = (completed: boolean, timedOut: boolean): PollResult<T> => ({
    jobId, completed, timedOut, elapsedMs: Math.round(performance.now() - started),
    ...(job === undefined ? {} : { job }),
  })
  try {
    while (true) {
      const next = await options.query(combined)
      if (job !== undefined && !options.sameIdentity(job, next)) {
        throw new BridgeError('INVALID_BACKEND_RESPONSE', 'The job identity or execution mode changed while polling.')
      }
      job = next
      if (options.terminal(job)) return result(true, false)
      await delay(pollIntervalMs, undefined, { signal: combined })
    }
  } catch (cause) {
    signal.throwIfAborted()
    if (deadline.aborted) return result(false, true)
    if (cause instanceof BridgeError) return { ...result(false, false), queryError: { code: cause.code, message: cause.message } }
    throw cause
  }
}
