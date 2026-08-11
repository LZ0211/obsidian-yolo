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

const createWorker = (): Worker => {
  const blob = new Blob([workerSource], { type: 'text/javascript' })
  const worker = new Worker(URL.createObjectURL(blob))
  worker.onerror = () => {
    // Surface as a rejected pending request; the next call retries a fresh
    // worker.
    failAll('jieba worker error')
    worker.terminate()
    if (currentWorker === worker) currentWorker = null
  }
  return worker
}

let currentWorker: Worker | null = null
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

const getWorker = (): Worker => {
  if (currentWorker) return currentWorker
  currentWorker = createWorker()
  currentWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data
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

export const jiebaEngineComponent = {
  cutForSearch(text: string): Promise<string[]> {
    const worker = getWorker()
    const id = nextRequestId++
    return new Promise<string[]>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      const request: WorkerRequest = { type: 'cut_for_search', id, text }
      worker.postMessage(request)
    })
  },

  dispose(): void {
    failAll('jieba component disposed')
    currentWorker?.terminate()
    currentWorker = null
  },
}
