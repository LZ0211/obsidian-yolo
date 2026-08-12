import { createCompleteToolCallArguments } from '../../../types/tool-call.types'

import { buildSubagentApprovalSummary } from './subagentApprovalSummary'

describe('buildSubagentApprovalSummary', () => {
  it('summarizes fs_search with scope and query', () => {
    const summary = buildSubagentApprovalSummary({
      id: '1',
      name: 'yolo_local__fs_search',
      arguments: createCompleteToolCallArguments({
        value: {
          scope: 'folder',
          query: 'architecture decision record',
        },
      }),
    })

    expect(summary).toEqual({
      label: 'fs_search',
      detail: 'folder | architecture decision record',
    })
  })

  it('summarizes meta_search with metadata DSL', () => {
    const summary = buildSubagentApprovalSummary({
      id: '2',
      name: 'yolo_local__meta_search',
      arguments: createCompleteToolCallArguments({
        value: {
          meta: 'select * from * where tag = "ai" order by title asc limit 5',
        },
      }),
    })

    expect(summary).toEqual({
      label: 'meta_search',
      detail: 'select * from * where tag = "ai" order by title asc limit 5',
    })
  })
})
