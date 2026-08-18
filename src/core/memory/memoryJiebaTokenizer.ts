import { logFlightEvent } from '../../utils/debug/flightLog'
import { acquireRuntimeComponent } from '../runtime-components/runtimeComponentAccess'

import { normalizeMemoryText } from './memoryTokenizer'

/**
 * jieba-rs WASM segmentation via the jieba-engine runtime component
 * (dedicated worker thread; the component is inlined, no network fetch).
 *
 * The memory index uses this as an async enhancement: when the component is
 * available (and enabled), reconcile/query keywords come from jieba's
 * search-engine mode (long words + sub-tokens); otherwise callers fall back
 * to the built-in synchronous tokenizer (Intl.Segmenter + bigrams).
 */

/** Local WASM cut is normally <50ms; a hung worker must not stall the turn. */
export const JIEBA_CUT_TIMEOUT_MS = 3_000

const componentAvailable = (): boolean => true

export const isJiebaComponentAvailable = (): boolean => componentAvailable()

/**
 * Cut text into jieba search-engine tokens. Returns null when the component
 * is unavailable, times out, or fails, so callers can fall back to the
 * built-in tokenizer without distinguishing failure modes.
 */
export async function cutForSearchWithJieba(
  text: string,
): Promise<string[] | null> {
  if (!componentAvailable()) return null
  try {
    const lease = await acquireRuntimeComponent('jieba-engine')
    try {
      const tokens = await withCutTimeout(
        lease.api.cutForSearch(normalizeMemoryText(text)),
      )
      return tokens.filter(Boolean)
    } finally {
      lease.release()
    }
  } catch (error) {
    console.warn('[YOLO][Memory] jieba segmentation unavailable', error)
    return null
  }
}

const withCutTimeout = (promise: Promise<string[]>): Promise<string[]> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        logFlightEvent('memory', 'jieba-cut-timeout', {
          detail: `${JIEBA_CUT_TIMEOUT_MS}ms without worker response`,
          consoleOutput: 'warn',
        })
        reject(new Error(`jieba cut timed out after ${JIEBA_CUT_TIMEOUT_MS}ms`))
      }, JIEBA_CUT_TIMEOUT_MS)
    }),
  ]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
}
