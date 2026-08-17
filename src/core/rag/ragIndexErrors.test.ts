import { DatabaseSaveFailedError } from '../../database/exception'

import {
  RagIndexAbandonedError,
  RagIndexIncompleteError,
  classifyRagIndexError,
  isTransientRagIndexError,
} from './ragIndexErrors'

describe('classifyRagIndexError - RagIndexIncompleteError', () => {
  it('classifies RagIndexIncompleteError as transient', () => {
    const error = new RagIndexIncompleteError(['a.md', 'b.md'])
    expect(classifyRagIndexError(error)).toBe('transient')
    expect(isTransientRagIndexError(error)).toBe(true)
  })

  it('carries the rolled-back paths', () => {
    const error = new RagIndexIncompleteError(['a.md', 'b.md'])
    expect(error.rolledBackPaths).toEqual(['a.md', 'b.md'])
    expect(error.name).toBe('RagIndexIncompleteError')
  })
})

describe('classifyRagIndexError - DatabaseSaveFailedError', () => {
  it('classifies DatabaseSaveFailedError as permanent', () => {
    // dumpDataDir OOM is the canonical case (#408): we don't want this to
    // enter the transient retry loop, since retrying immediately won't shrink
    // the snapshot. The run should land on `failed` and surface to the user.
    const oom = new RangeError('Array buffer allocation failed')
    const error = new DatabaseSaveFailedError(oom)
    expect(classifyRagIndexError(error)).toBe('permanent')
    expect(isTransientRagIndexError(error)).toBe(false)
  })

  it('preserves the underlying cause', () => {
    const cause = new Error('disk full')
    const error = new DatabaseSaveFailedError(cause)
    expect(error.cause).toBe(cause)
    expect(error.name).toBe('DatabaseSaveFailedError')
    expect(error.message).toContain('disk full')
  })
})

describe('classifyRagIndexError - RagIndexAbandonedError', () => {
  it('classifies RagIndexAbandonedError as permanent', () => {
    // Repeated permanent embedding failures abandon the remaining files: the
    // run must land on `failed` and NOT enter the transient retry loop —
    // retrying won't help a broken embedding configuration.
    const error = new RagIndexAbandonedError(5, 3)
    expect(classifyRagIndexError(error)).toBe('permanent')
    expect(isTransientRagIndexError(error)).toBe(false)
  })

  it('carries the consecutive failure count and remaining file count', () => {
    const error = new RagIndexAbandonedError(5, 3)
    expect(error.name).toBe('RagIndexAbandonedError')
    expect(error.consecutiveFailedFiles).toBe(5)
    expect(error.remainingFiles).toBe(3)
    expect(error.message).toContain('5')
    expect(error.message).toContain('3')
  })
})
