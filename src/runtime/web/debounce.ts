export type DebouncedCallback<T extends (...args: never[]) => void> = ((
  ...args: Parameters<T>
) => void) & {
  cancel: () => void
}

export function debounce<T extends (...args: never[]) => void>(
  callback: T,
  waitMs: number,
  immediate = false,
): DebouncedCallback<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const debounced = ((...args: Parameters<T>) => {
    const callImmediately = immediate && timeoutId === null
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
    }
    timeoutId = setTimeout(() => {
      timeoutId = null
      if (!immediate) callback(...args)
    }, waitMs)
    if (callImmediately) callback(...args)
  }) as DebouncedCallback<T>

  debounced.cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
  }

  return debounced
}
