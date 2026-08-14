import { getLocalFileToolServerName } from '../../mcp/localFileToolNames'
import { getToolName } from '../../mcp/tool-name-utils'

import {
  filterAllowedToolsForSubagent,
  isSubagentBlockedToolName,
} from './tool-filter'
import { SUBAGENT_BLOCKED_TOOL_SHORT_NAMES } from './tool-name-utils'

describe('subagent tool-filter', () => {
  const fsEdit = getToolName(getLocalFileToolServerName(), 'fs_edit')
  const delegate = getToolName(
    getLocalFileToolServerName(),
    'delegate_subagent',
  )
  const terminal = getToolName(getLocalFileToolServerName(), 'terminal_command')
  const askUser = getToolName(getLocalFileToolServerName(), 'ask_user_question')

  it('blocks recursive and interactive delegation tools by FQN', () => {
    for (const shortName of SUBAGENT_BLOCKED_TOOL_SHORT_NAMES) {
      const fqn = getToolName(getLocalFileToolServerName(), shortName)
      expect(isSubagentBlockedToolName(fqn)).toBe(true)
    }
  })

  it('filters parent allowlist without blanket fs bans', () => {
    const parent = [
      fsEdit,
      delegate,
      terminal,
      askUser,
      'mcp_server__remote_tool',
    ]

    const filtered = filterAllowedToolsForSubagent(parent)
    expect(filtered).toEqual([fsEdit, terminal, 'mcp_server__remote_tool'])
  })

  it('treats a missing parent allowlist as no inherited tools', () => {
    expect(filterAllowedToolsForSubagent(undefined)).toEqual([])
  })

  it('blocks project_ops and scheduled_task_ops from every child run (M3 regression: children inherited them)', () => {
    // RED before M3: the deny-list lacked project_ops (backup constants.ts had
    // it) and scheduled_task_ops (the consolidated task tool), so a child
    // subagent inherited both from the parent tool set and could mutate
    // persistent project / scheduled-task state.
    const projectOps = getToolName(getLocalFileToolServerName(), 'project_ops')
    const scheduledTaskOps = getToolName(
      getLocalFileToolServerName(),
      'scheduled_task_ops',
    )
    const parent = [
      projectOps,
      scheduledTaskOps,
      getToolName(getLocalFileToolServerName(), 'fs_read'),
    ]

    expect(isSubagentBlockedToolName(projectOps)).toBe(true)
    expect(isSubagentBlockedToolName(scheduledTaskOps)).toBe(true)
    expect(filterAllowedToolsForSubagent(parent)).toEqual([
      getToolName(getLocalFileToolServerName(), 'fs_read'),
    ])
  })

  it('does not filter approval-gated tools — those route to the parent UI', () => {
    // Tools that merely require approval (js_eval with caps, fs_edit in
    // review mode, etc.) are intentionally NOT in the deny-list. Their
    // approval requests bubble up to the SubagentCard's inline approval
    // block. See `docs/plans/2026-06-18-subagent-tool-approval-routing.md`.
    const jsEval = getToolName(getLocalFileToolServerName(), 'js_eval')
    expect(isSubagentBlockedToolName(jsEval)).toBe(false)
    expect(filterAllowedToolsForSubagent([fsEdit, jsEval])).toEqual([
      fsEdit,
      jsEval,
    ])
  })
})
