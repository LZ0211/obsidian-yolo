import { buildActiveProjectContextBlock, resolveActiveProjectContext } from './context'
import { createStore, initSimpleProject } from './projectTestUtils'

describe('buildActiveProjectContextBlock', () => {
  it('emits a compact live identity block', () => {
    const block = buildActiveProjectContextBlock({
      schemaVersion: 2,
      projectId: 'proj-agent-loop',
      projectName: 'Agent Loop',
      status: 'in_progress',
      revision: 3,
      createdAt: '2026-07-31T09:00:00.000Z',
      updatedAt: '2026-07-31T14:00:00.000Z',
    })
    expect(block).toContain('<project_id>proj-agent-loop</project_id>')
    expect(block).toContain('<name>Agent Loop</name>')
    expect(block).toContain('<status>in_progress</status>')
    expect(block).toContain('<revision>3</revision>')
    expect(block).not.toContain('<task_id>')
  })

  it('escapes display text in the XML block', () => {
    const block = buildActiveProjectContextBlock({
      schemaVersion: 2,
      projectId: 'proj-1',
      projectName: 'A <B> & "C"',
      status: 'in_progress',
      revision: 1,
      createdAt: '2026-07-31T09:00:00.000Z',
      updatedAt: '2026-07-31T14:00:00.000Z',
    })
    expect(block).toContain('<name>A &lt;B&gt; &amp; &quot;C&quot;</name>')
  })
})

describe('resolveActiveProjectContext', () => {
  it('resolves from the store fresh', async () => {
    const store = createStore()
    await initSimpleProject(store)
    const result = await resolveActiveProjectContext(store, 'proj-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.block).toContain('<project_id>proj-1</project_id>')
      expect(result.block).toContain('<name>Proj One</name>')
    }
  })

  it('returns a repair error for a missing project', async () => {
    const store = createStore()
    const result = await resolveActiveProjectContext(store, 'proj-gone')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('could not be resolved')
  })
})
