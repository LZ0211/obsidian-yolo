export type SseResponseWriterCloseCode = 'slow_consumer'

export type SseWritableResponse = {
  write: (chunk: string) => boolean
  once: (event: 'drain', listener: () => void) => unknown
  end: () => void
}

export type SseResponseWriterOptions = {
  maxPendingBytes: number
  onClose?: (code: SseResponseWriterCloseCode) => void
}

export class SseResponseWriter {
  private readonly pendingChunks: string[] = []
  private pendingBytes = 0
  private waitingForDrain = false
  private closed = false

  constructor(
    private readonly response: SseWritableResponse,
    private readonly options: SseResponseWriterOptions,
  ) {}

  get isClosed(): boolean {
    return this.closed
  }

  write(chunk: string): void {
    if (this.closed) return
    if (this.waitingForDrain) {
      this.enqueue(chunk)
      return
    }
    this.writeNow(chunk)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.pendingChunks.length = 0
    this.pendingBytes = 0
    this.response.end()
  }

  private enqueue(chunk: string): void {
    this.pendingChunks.push(chunk)
    this.pendingBytes += Buffer.byteLength(chunk)
    if (this.pendingBytes > this.options.maxPendingBytes) {
      this.closed = true
      this.pendingChunks.length = 0
      this.pendingBytes = 0
      this.options.onClose?.('slow_consumer')
      this.response.end()
    }
  }

  private writeNow(chunk: string): void {
    if (this.response.write(chunk) !== false) return
    this.waitingForDrain = true
    this.response.once('drain', () => {
      this.waitingForDrain = false
      this.flush()
    })
  }

  private flush(): void {
    while (!this.closed && !this.waitingForDrain) {
      const chunk = this.pendingChunks.shift()
      if (chunk == null) return
      this.pendingBytes -= Buffer.byteLength(chunk)
      this.writeNow(chunk)
    }
  }
}
