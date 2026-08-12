import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { PromptSnapshotSqliteStore } from '../../sqlite/promptSnapshotSqliteStore'

describe('PromptSnapshotSqliteStore', () => {
  let directory: string
  let store: PromptSnapshotSqliteStore

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'prompt-snapshot-sqlite-'),
    )
    store = new PromptSnapshotSqliteStore(
      path.join(directory, 'conversation.sqlite'),
    )
  })

  afterEach(() => {
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('replaces entries and reads them back with timestamps preserved', () => {
    store.replace(
      'conversation-1',
      {
        hash1: { hash: 'hash1', content: 'one', createdAt: 1, updatedAt: 2 },
        hash2: {
          hash: 'hash2',
          content: ['a', 'b'],
          createdAt: 3,
          updatedAt: 4,
        },
      },
      new Set(['hash1', 'hash2']),
    )

    expect(store.readContent('conversation-1', 'hash1')).toBe('one')
    expect(store.readContent('conversation-1', 'hash2')).toEqual(['a', 'b'])
    expect(store.readContent('conversation-1', 'missing')).toBeNull()
    expect(store.readFullEntries('conversation-1')['hash1']).toEqual({
      content: 'one',
      createdAt: 1,
      updatedAt: 2,
    })
  })

  it('drops entries that are not in the keep set on the next replace', () => {
    store.replace(
      'conversation-1',
      {
        hash1: { hash: 'hash1', content: 'one', createdAt: 1, updatedAt: 1 },
        hash2: { hash: 'hash2', content: 'two', createdAt: 1, updatedAt: 1 },
      },
      new Set(['hash1', 'hash2']),
    )
    store.replace(
      'conversation-1',
      {
        hash1: { hash: 'hash1', content: 'one', createdAt: 1, updatedAt: 1 },
        hash2: { hash: 'hash2', content: 'two', createdAt: 1, updatedAt: 1 },
      },
      new Set(['hash1']),
    )

    expect(store.readContent('conversation-1', 'hash1')).toBe('one')
    expect(store.readContent('conversation-1', 'hash2')).toBeNull()
  })

  it('isolates conversations and clears all', () => {
    store.replace(
      'conversation-1',
      { hash1: { hash: 'hash1', content: 'one', createdAt: 1, updatedAt: 1 } },
      new Set(['hash1']),
    )
    store.replace(
      'conversation-2',
      { hash2: { hash: 'hash2', content: 'two', createdAt: 1, updatedAt: 1 } },
      new Set(['hash2']),
    )

    store.clearConversation('conversation-1')
    expect(store.readContent('conversation-1', 'hash1')).toBeNull()
    expect(store.readContent('conversation-2', 'hash2')).toBe('two')

    store.clearAll()
    expect(store.readContent('conversation-2', 'hash2')).toBeNull()
  })
})
