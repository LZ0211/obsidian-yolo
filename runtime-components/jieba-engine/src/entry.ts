/**
 * jieba-engine runtime component.
 *
 * Chinese word segmentation (jieba-rs WASM) executed inside a dedicated
 * worker thread. The worker script — jieba glue + base64-embedded WASM +
 * `cut_for_search` message handling — is inlined at build time (virtual
 * module), so the component is a single self-contained entry.js with no
 * network fetch at runtime.
 *
 * The API is deliberately narrow: `cutForSearch(text)` mirrors jieba's
 * search-engine mode (long words plus their sub-tokens, e.g.
 * "北京烤鸭" → 北京/烤鸭/北京烤鸭), which is what the memory tokenizer
 * needs for Chinese recall.
 */

import workerSource from 'virtual:jieba-worker-script'

type WorkerRequest = {
  type: 'cut_for_search'
  id: number
  text: string
}

type WorkerResponse =
  | { type: 'result'; id: number; tokens: string[] }
  | { type: 'error'; id: number; message: string }
  | { type: 'ready' }

type ReadyWaiter = {
  resolve: () => void
  reject: (error: Error) => void
}

/** The glue is ESM; a module worker is required for its import/export syntax. */
const createWorker = (): Worker => {
  const blob = new Blob([workerSource], { type: 'text/javascript' })
  const worker = new Worker(URL.createObjectURL(blob), { type: 'module' })
  worker.onerror = (event) => {
    // Surface as rejected pending requests and ready waiters; the next call
    // retries a fresh worker.
    console.warn('[YOLO][jieba-engine] worker error', event.message)
    failAll(`jieba worker error: ${event.message}`)
    failReadyWaiters(`jieba worker error: ${event.message}`)
    worker.terminate()
    if (currentWorker === worker) currentWorker = null
  }
  return worker
}

let currentWorker: Worker | null = null
let workerReady = false
const readyWaiters: ReadyWaiter[] = []
let nextRequestId = 1
const pending = new Map<
  number,
  { resolve: (tokens: string[]) => void; reject: (error: Error) => void }
>()

const failAll = (message: string): void => {
  for (const [, entry] of pending) {
    entry.reject(new Error(message))
  }
  pending.clear()
}

const failReadyWaiters = (message: string): void => {
  for (const waiter of readyWaiters.splice(0)) {
    waiter.reject(new Error(message))
  }
}

const getWorker = (): Worker => {
  if (currentWorker) return currentWorker
  workerReady = false
  currentWorker = createWorker()
  currentWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data
    if (response.type === 'ready') {
      // Chromium can drop a postMessage sent before the blob worker starts
      // executing; requests are buffered until this handshake arrives.
      workerReady = true
      for (const waiter of readyWaiters.splice(0)) waiter.resolve()
      return
    }
    const entry = pending.get(response.id)
    if (!entry) return
    pending.delete(response.id)
    if (response.type === 'result') {
      entry.resolve(response.tokens)
    } else {
      entry.reject(new Error(response.message))
    }
  }
  return currentWorker
}

/** Worker startup decodes 4MB of WASM and instantiates it — allow time. */
const READY_TIMEOUT_MS = 10_000

const awaitWorkerReady = (): Promise<void> => {
  if (workerReady) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const waiterIndex = readyWaiters.findIndex(
        (waiter) => waiter.resolve === resolve,
      )
      if (waiterIndex >= 0) readyWaiters.splice(waiterIndex, 1)
      console.warn(
        `[YOLO][jieba-engine] worker did not become ready within ${READY_TIMEOUT_MS}ms; recycling`,
      )
      currentWorker?.terminate()
      currentWorker = null
      reject(new Error(`jieba worker did not become ready within ${READY_TIMEOUT_MS}ms`))
    }, READY_TIMEOUT_MS)
    readyWaiters.push({
      resolve: () => {
        clearTimeout(timeoutId)
        resolve()
      },
      reject: (error) => {
        clearTimeout(timeoutId)
        reject(error)
      },
    })
  })
}

/** A cut is normally sub-100ms; past this the worker is wedged. */
const CUT_TIMEOUT_MS = 2_000

export const jiebaEngineComponent = {
  cutForSearch(text: string): Promise<string[]> {
    const worker = getWorker()
    const id = nextRequestId++
    return awaitWorkerReady().then(
      () =>
        new Promise<string[]>((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            pending.delete(id)
            // The worker is wedged (WASM init or cut never returns, no error
            // event fires). Kill it so the next call starts a fresh worker,
            // and reject the remaining pending requests.
            console.warn(
              `[YOLO][jieba-engine] cut timed out after ${CUT_TIMEOUT_MS}ms; recycling worker`,
            )
            failAll(`jieba cut timed out after ${CUT_TIMEOUT_MS}ms`)
            currentWorker?.terminate()
            currentWorker = null
            reject(new Error(`jieba cut timed out after ${CUT_TIMEOUT_MS}ms`))
          }, CUT_TIMEOUT_MS)
          pending.set(id, {
            resolve: (tokens) => {
              clearTimeout(timeoutId)
              resolve(tokens)
            },
            reject: (error) => {
              clearTimeout(timeoutId)
              reject(error)
            },
          })
          const request: WorkerRequest = { type: 'cut_for_search', id, text }
          worker.postMessage(request)
        }),
    )
  },

  dispose(): void {
    failAll('jieba component disposed')
    failReadyWaiters('jieba component disposed')
    workerReady = false
    currentWorker?.terminate()
    currentWorker = null
  },
}

globalThis.__yolo_register_runtime_component__({
  id: 'jieba-engine',
  create(): typeof jiebaEngineComponent {
    return jiebaEngineComponent
  },
})
