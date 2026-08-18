import {
  acquireRuntimeComponent,
} from '../runtime-components/runtimeComponentAccess'

import { cutForSearchWithJieba } from './memoryJiebaTokenizer'

jest.mock('../runtime-components/runtimeComponentAccess', () => ({
  acquireRuntimeComponent: jest.fn(),
}))

const acquireMock = jest.mocked(acquireRuntimeComponent)

const leaseFor = (cutForSearch: () => Promise<string[]>) =>
  ({
    api: { cutForSearch },
    release: jest.fn(),
  }) as never

describe('cutForSearchWithJieba', () => {
  beforeEach(() => {
    acquireMock.mockReset()
  })

  it('returns tokens when the worker responds', async () => {
    acquireMock.mockResolvedValue(
      leaseFor(async () => ['北京', '烤鸭', '北京烤鸭']),
    )

    await expect(cutForSearchWithJieba('北京烤鸭')).resolves.toEqual([
      '北京',
      '烤鸭',
      '北京烤鸭',
    ])
    expect(acquireMock).toHaveBeenCalledWith('jieba-engine')
  })

  it('returns null when the component is unavailable', async () => {
    acquireMock.mockRejectedValue(new Error('jieba-engine is disabled'))

    await expect(cutForSearchWithJieba('北京烤鸭')).resolves.toBeNull()
  })

  it('returns null when the worker never responds instead of hanging the turn', async () => {
    jest.useFakeTimers()
    try {
      acquireMock.mockResolvedValue(
        leaseFor(() => new Promise<string[]>(() => undefined)),
      )

      const resultPromise = cutForSearchWithJieba('北京烤鸭')
      await jest.advanceTimersByTimeAsync(3_100)
      await expect(resultPromise).resolves.toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })
})
