/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import { EventEmitter } from 'node:events'

import { SseResponseWriter } from './SseResponseWriter'

class FakeResponse extends EventEmitter {
  readonly writes: string[] = []
  ended = false
  private readonly writeResults: boolean[]

  constructor(writeResults: boolean[]) {
    super()
    this.writeResults = writeResults
  }

  write(chunk: string): boolean {
    this.writes.push(chunk)
    return this.writeResults.shift() ?? true
  }

  end(): void {
    this.ended = true
  }
}

describe('SseResponseWriter', () => {
  it('waits for drain before writing queued chunks', () => {
    const response = new FakeResponse([false, true])
    const writer = new SseResponseWriter(response, { maxPendingBytes: 100 })

    writer.write('first')
    writer.write('second')

    expect(response.writes).toEqual(['first'])
    response.emit('drain')
    expect(response.writes).toEqual(['first', 'second'])
  })

  it('closes a slow consumer when pending data exceeds the limit', () => {
    const response = new FakeResponse([false])
    const onClose = jest.fn()
    const writer = new SseResponseWriter(response, {
      maxPendingBytes: 5,
      onClose,
    })

    writer.write('first')
    writer.write('second')

    expect(onClose).toHaveBeenCalledWith('slow_consumer')
    expect(response.ended).toBe(true)
  })
})
