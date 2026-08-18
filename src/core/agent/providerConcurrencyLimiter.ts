import { logFlightEvent } from '../../utils/debug/flightLog'

const MAX_CONCURRENT_REQUESTS_PER_PROVIDER = 10

type Waiter = () => void

const activeByProvider = new Map<string, number>()
const waitersByProvider = new Map<string, Waiter[]>()

export async function withProviderConcurrency<T>(
  providerId: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const queuedAt = Date.now()
  await acquire(providerId, signal)
  // A direct acquire sees active === 1; anything higher means we waited for a
  // slot, so the queue depth is exactly the reason a turn may feel stalled.
  if ((activeByProvider.get(providerId) ?? 1) > 1) {
    logFlightEvent('llm', 'concurrency-queued', {
      id: providerId,
      detail: `waited ${Date.now() - queuedAt}ms active=${activeByProvider.get(providerId)}`,
      consoleOutput: 'warn',
    })
  }
  try {
    return await operation()
  } finally {
    release(providerId)
  }
}

async function acquire(
  providerId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError')
  }
  const active = activeByProvider.get(providerId) ?? 0
  if (active < MAX_CONCURRENT_REQUESTS_PER_PROVIDER) {
    activeByProvider.set(providerId, active + 1)
    return
  }
  await new Promise<void>((resolve, reject) => {
    const waiters = waitersByProvider.get(providerId) ?? []
    const waiter = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const abort = () => {
      const index = waiters.indexOf(waiter)
      if (index >= 0) waiters.splice(index, 1)
      if (waiters.length === 0) waitersByProvider.delete(providerId)
      reject(new DOMException('Request aborted', 'AbortError'))
    }
    waiters.push(waiter)
    signal?.addEventListener('abort', abort, { once: true })
    waitersByProvider.set(providerId, waiters)
  })
  activeByProvider.set(providerId, (activeByProvider.get(providerId) ?? 0) + 1)
}

function release(providerId: string): void {
  const active = activeByProvider.get(providerId) ?? 1
  const remaining = Math.max(0, active - 1)
  if (remaining === 0) activeByProvider.delete(providerId)
  else activeByProvider.set(providerId, remaining)

  const waiters = waitersByProvider.get(providerId)
  const waiter = waiters?.shift()
  if (waiters?.length === 0) waitersByProvider.delete(providerId)
  waiter?.()
}
