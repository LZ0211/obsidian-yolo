import { WebRouter } from './WebRouter'

describe('WebRouter', () => {
  it('matches exact and parameterized routes', () => {
    const router = new WebRouter()
    const exact = jest.fn()
    const parameterized = jest.fn()

    router.get('/api/bootstrap', exact)
    router.post('/api/agent/abort/:runId', parameterized)

    expect(router.resolve('GET', '/api/bootstrap?x=1')).toEqual({
      handler: exact,
      params: {},
    })
    expect(router.resolve('POST', '/api/agent/abort/run%201')).toEqual({
      handler: parameterized,
      params: { runId: 'run 1' },
    })
    expect(router.resolve('GET', '/api/agent/abort/run-1')).toBeNull()
  })
})
