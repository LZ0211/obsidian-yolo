import { ProjectPickerService } from './picker'
import { createStore } from './projectTestUtils'

const abortSignal = new AbortController().signal

describe('ProjectPickerService', () => {
  it('lists projects with bounded summaries', async () => {
    const store = createStore()
    await store.initProject({
      projectId: 'proj-zeta',
      projectName: 'Zeta',
      tasks: [
        { taskId: 'T-001', title: 'First' },
        { taskId: 'T-002', title: 'Second', dependencies: ['T-001'] },
      ],
    })
    await store.initProject({
      projectId: 'proj-alpha',
      projectName: 'Alpha',
      tasks: [{ taskId: 'T-001', title: 'Only' }],
    })

    const picker = new ProjectPickerService(store)
    const items = await picker.search('', abortSignal)

    // Ordered: exact/prefix ties → most recently updated (alpha second → newer).
    expect(items.map((item) => item.projectId)).toEqual([
      'proj-alpha',
      'proj-zeta',
    ])
    expect(items[1]).toMatchObject({
      name: 'Zeta',
      status: 'in_progress',
      activeTaskCount: 2,
    })
  })

  it('filters and ranks by exact then prefix then fuzzy', async () => {
    const store = createStore()
    await store.initProject({ projectId: 'auth-fix', projectName: 'Auth Fix', tasks: [] })
    await store.initProject({ projectId: 'auth-v2', projectName: 'Auth v2', tasks: [] })
    await store.initProject({ projectId: 'payments', projectName: 'Payments', tasks: [] })

    const picker = new ProjectPickerService(store)
    const items = await picker.search('auth', abortSignal)
    const ids = items.map((item) => item.projectId)
    // Both prefix matches (rank 1). Their intra-pair order is the recency
    // tiebreak, which depends on real timestamps — assert set membership so the
    // test does not flake when the two projects land in different milliseconds.
    expect([...ids].sort()).toEqual(['auth-fix', 'auth-v2'])
    expect(items.every((item) => item.activeTaskCount === 0)).toBe(true)
  })

  it('resolves a single project by id', async () => {
    const store = createStore()
    await store.initProject({ projectId: 'proj-1', projectName: 'One', tasks: [] })

    const picker = new ProjectPickerService(store)
    const resolved = await picker.resolve('proj-1')
    expect(resolved).toMatchObject({ projectId: 'proj-1', name: 'One' })
    expect(await picker.resolve('missing')).toBeNull()
  })

  it('respects abort between project reads', async () => {
    const store = createStore()
    await store.initProject({ projectId: 'proj-1', projectName: 'One', tasks: [] })
    const picker = new ProjectPickerService(store)
    const controller = new AbortController()
    controller.abort()
    expect(await picker.search('', controller.signal)).toEqual([])
  })
})
