// src/core/agent/consolidated-tools.test.ts
import {
  LEGACY_TOOL_TO_CAPABILITY,
  capabilityKey,
  resolveConsolidatedAction,
  validateConsolidatedAction,
} from './consolidated-tools'

describe('capabilityKey', () => {
  it('joins tool and action', () => {
    expect(capabilityKey({ toolName: 'fs_file_ops', action: 'move' })).toBe(
      'fs_file_ops:move',
    )
  })
})

describe('LEGACY_TOOL_TO_CAPABILITY', () => {
  it('maps all eighteen legacy names', () => {
    expect(Object.keys(LEGACY_TOOL_TO_CAPABILITY)).toHaveLength(18)
    expect(LEGACY_TOOL_TO_CAPABILITY.fs_delete).toBe('fs_file_ops:delete')
    expect(LEGACY_TOOL_TO_CAPABILITY.scheduled_task_run_now).toBe(
      'scheduled_task_ops:run_now',
    )
    expect(LEGACY_TOOL_TO_CAPABILITY.context_compact).toBe(
      'context_manage:compact',
    )
    expect(LEGACY_TOOL_TO_CAPABILITY.memory_add).toBe('memory_ops:add')
    expect(LEGACY_TOOL_TO_CAPABILITY.browser_type).toBe('browser_ops:type')
    expect(LEGACY_TOOL_TO_CAPABILITY.browser_scroll).toBe('browser_ops:scroll')
  })
})

describe('validateConsolidatedAction', () => {
  it('rejects cross-action payloads for fs_file_ops', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'fs_file_ops', action: 'delete' },
        { path: '/a', oldPath: '/b', newPath: '/c' },
      ),
    ).toThrow(/oldPath/)
  })
  it('rejects delete without path', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'fs_file_ops', action: 'delete' },
        {},
      ),
    ).toThrow(/path/)
  })
  it('allows memory_ops add with items batch', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'memory_ops', action: 'add' },
        { items: [{ content: 'x' }] },
      ),
    ).not.toThrow()
  })
  it('rejects memory_ops batch when standalone action fields are present', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'memory_ops', action: 'add' },
        { content: 'x', operations: [{ action: 'delete', id: 'm1' }] },
      ),
    ).toThrow(/operations/)
  })
  it('treats null optional fields as omitted', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'memory_ops', action: 'delete' },
        { id: 'm1', scope: null },
      ),
    ).not.toThrow()
  })
  it('resolves memory_ops batch mode from operations without an action and validates it', () => {
    expect(
      resolveConsolidatedAction('memory_ops', {
        operations: [{ action: 'delete', id: 'm1' }],
      }),
    ).toEqual({ toolName: 'memory_ops', action: 'batch' })
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'memory_ops', action: 'batch' },
        { operations: [{ action: 'delete', id: 'm1' }] },
      ),
    ).not.toThrow()
  })
  it('rejects scheduled_task create without matching schedule field', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'scheduled_task_ops', action: 'create' },
        { name: 't', scheduleType: 'cron', agentPrompt: 'p' },
      ),
    ).toThrow(/cronExpression/)
  })
  it('rejects memory_ops update with operations present', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'memory_ops', action: 'update' },
        {
          id: 'm1',
          new_content: 'x',
          operations: [{ action: 'delete', id: 'm2' }],
        },
      ),
    ).toThrow(/batch fields/)
  })
  it('rejects memory_ops delete with operations present', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'memory_ops', action: 'delete' },
        { id: 'm1', operations: [{ action: 'delete', id: 'm2' }] },
      ),
    ).toThrow(/add\/update fields/)
  })
  it('rejects scheduled_task get with a mutation field', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'scheduled_task_ops', action: 'get' },
        { id: 't1', enabled: true },
      ),
    ).toThrow(/mutation fields/)
  })
  it('rejects scheduled_task run_now with a mutation field', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'scheduled_task_ops', action: 'run_now' },
        { id: 't1', priority: 1 },
      ),
    ).toThrow(/mutation fields/)
  })
  it('requires pageId+direction for browser scroll and rejects action fields', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'browser_ops', action: 'scroll' },
        { pageId: 'p', direction: 'down' },
      ),
    ).not.toThrow()
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'browser_ops', action: 'scroll' },
        { pageId: 'p' },
      ),
    ).toThrow(/direction/)
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'browser_ops', action: 'scroll' },
        { pageId: 'p', direction: 'down', url: 'https://x' },
      ),
    ).toThrow(/rejects/)
  })
  it('requires pageId+url for browser navigate', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'browser_ops', action: 'navigate' },
        { pageId: 'p', url: 'https://x' },
      ),
    ).not.toThrow()
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'browser_ops', action: 'navigate' },
        { pageId: 'p' },
      ),
    ).toThrow(/url/)
  })
  it('requires pageId+selector for browser click', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'browser_ops', action: 'click' },
        { pageId: 'p', selector: '#go' },
      ),
    ).not.toThrow()
  })
  it('requires pageId+selector+text for browser type and rejects cross-action fields', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'browser_ops', action: 'type' },
        { pageId: 'p', selector: '#q', text: 'hi' },
      ),
    ).not.toThrow()
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'browser_ops', action: 'type' },
        { pageId: 'p', selector: '#q' },
      ),
    ).toThrow(/text/)
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'browser_ops', action: 'type' },
        { pageId: 'p', selector: '#q', text: 'hi', url: 'https://x' },
      ),
    ).toThrow(/rejects/)
  })
})

describe('project_ops validators', () => {
  it('rejects init without projectName', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'project_ops', action: 'init' },
        { projectId: 'p1', tasks: [{ taskId: 'T-001', title: 'First' }] },
      ),
    ).toThrow(/projectName/)
  })
  it('rejects init with task-scoped / review fields', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'project_ops', action: 'init' },
        { projectId: 'p1', projectName: 'P', taskId: 'T-001' },
      ),
    ).toThrow(/task-scoped/)
  })
  it('allows init with projectName and tasks', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'project_ops', action: 'init' },
        { projectId: 'p1', projectName: 'P', tasks: [{ taskId: 'T-001', title: 'First' }] },
      ),
    ).not.toThrow()
  })
  it('rejects get without projectId', () => {
    expect(() =>
      validateConsolidatedAction({ toolName: 'project_ops', action: 'get' }, {}),
    ).toThrow(/projectId/)
  })
  it('rejects get with review fields', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'project_ops', action: 'get' },
        { projectId: 'p1', decision: 'approved' },
      ),
    ).toThrow(/non-read/)
  })
  it('allows get with taskId and status filter', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'project_ops', action: 'get' },
        { projectId: 'p1', taskId: 'T-001', status: ['pending'] },
      ),
    ).not.toThrow()
  })
  it('rejects status without projectId', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'project_ops', action: 'status' },
        {},
      ),
    ).toThrow(/projectId/)
  })
  it('rejects status with a taskId', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'project_ops', action: 'status' },
        { projectId: 'p1', taskId: 'T-001' },
      ),
    ).toThrow(/only projectId/)
  })
  it('rejects update without patch or claim', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'project_ops', action: 'update' },
        {
          projectId: 'p1',
          taskId: 'T-001',
          expectedRevision: 1,
          expectedContentHash: 'h',
        },
      ),
    ).toThrow(/exactly one of patch or claim/)
  })
  it('rejects update with both patch and claim', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'project_ops', action: 'update' },
        {
          projectId: 'p1',
          taskId: 'T-001',
          expectedRevision: 1,
          expectedContentHash: 'h',
          patch: { status: 'in_progress' },
          claim: { runKey: 'r' },
        },
      ),
    ).toThrow(/exactly one of patch or claim/)
  })
  it('rejects update with review fields', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'project_ops', action: 'update' },
        {
          projectId: 'p1',
          taskId: 'T-001',
          expectedRevision: 1,
          expectedContentHash: 'h',
          patch: { status: 'in_progress' },
          decision: 'approved',
        },
      ),
    ).toThrow(/review/)
  })
  it('allows update with a claim', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'project_ops', action: 'update' },
        {
          projectId: 'p1',
          taskId: 'T-001',
          expectedRevision: 1,
          expectedContentHash: 'h',
          claim: { runKey: 'r' },
        },
      ),
    ).not.toThrow()
  })
  it('rejects review without decision', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'project_ops', action: 'review' },
        { projectId: 'p1', taskId: 'T-001' },
      ),
    ).toThrow(/decision/)
  })
  it('rejects review with patch/claim fields', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'project_ops', action: 'review' },
        {
          projectId: 'p1',
          taskId: 'T-001',
          decision: 'approved',
          patch: { status: 'in_progress' },
        },
      ),
    ).toThrow(/patch\/claim/)
  })
  it('allows review with evidence', () => {
    expect(() =>
      validateConsolidatedAction(
        { toolName: 'project_ops', action: 'review' },
        {
          projectId: 'p1',
          taskId: 'T-001',
          decision: 'approved',
          evidence: [{ kind: 'test', reference: 'r', summary: 's' }],
        },
      ),
    ).not.toThrow()
  })
})
