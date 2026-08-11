import { withProviderConcurrency } from './providerConcurrencyLimiter'

describe('withProviderConcurrency', () => {
  it('queues the eleventh request for one provider', async () => {
    const releases = Array.from({ length: 10 }, () => deferred<void>())
    const started: number[] = []
    const running = releases.map((release, index) =>
      withProviderConcurrency('provider-a', async () => {
        started.push(index)
        await release.promise
      }),
    )
    await Promise.resolve()
    const eleventh = withProviderConcurrency('provider-a', async () => {
      started.push(10)
    })

    await Promise.resolve()
    expect(started).toHaveLength(10)
    releases[0].resolve()
    await eleventh
    expect(started).toContain(10)
    for (const release of releases.slice(1)) release.resolve()
    await Promise.all(running)
  })

  it('removes an aborted request while it waits for a provider slot', async () => {
    const releases = Array.from({ length: 10 }, () => deferred<void>())
    const running = releases.map((release) =>
      withProviderConcurrency('provider-b', async () => release.promise),
    )
    await Promise.resolve()
    const controller = new AbortController()
    const queued = withProviderConcurrency(
      'provider-b',
      async () => undefined,
      controller.signal,
    )
    controller.abort()

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    for (const release of releases) release.resolve()
    await Promise.all(running)
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}
