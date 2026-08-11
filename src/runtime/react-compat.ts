export * from 'obsidian'

export function finishRenderMath(): Promise<void> {
  const maybeFinishRenderMath = (
    globalThis as typeof globalThis & {
      finishRenderMath?: () => Promise<void> | void
    }
  ).finishRenderMath
  return Promise.resolve(maybeFinishRenderMath?.())
}
