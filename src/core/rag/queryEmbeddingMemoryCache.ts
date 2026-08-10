export class QueryEmbeddingMemoryCache {
  private readonly entries = new Map<string, number[]>()

  constructor(private readonly maxEntries = 128) {}

  get(key: string): number[] | null {
    const value = this.entries.get(key)
    if (!value) return null
    this.entries.delete(key)
    this.entries.set(key, value)
    return [...value]
  }

  set(key: string, embedding: number[]): void {
    this.entries.delete(key)
    this.entries.set(key, [...embedding])
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined
      if (!oldestKey) return
      this.entries.delete(oldestKey)
    }
  }
}
