import type { WorkspaceAccessPolicy } from '../../types/assistant.types'

import {
  isAgentCompatibleWithDirectory,
  isConversationFileScopeLocked,
  normalizeConversationWorkingDirectory,
  resolveConversationFileScope,
} from './conversationFileScope'

const policy: WorkspaceAccessPolicy = {
  enabled: true,
  workspaceRoot: '/Projects',
  readExtraIncludes: ['/References'],
  readExcludes: ['/Projects/private'],
  writeExcludes: ['/Projects/locked'],
  protectedPaths: [
    { kind: 'prefix', path: '/YOLO' },
    { kind: 'namePrefix', dir: '/', name: 'sessions.sqlite' },
  ],
}

describe('conversationFileScope', () => {
  it('inherits the Agent policy and workspace root when unset', () => {
    expect(resolveConversationFileScope(policy, undefined)).toEqual({
      workingDirectory: '/Projects',
      workspaceAccessPolicy: policy,
    })
  })

  it('uses the Vault root without enabling a policy when both scopes are unset', () => {
    expect(resolveConversationFileScope(undefined, undefined)).toEqual({
      workingDirectory: '/',
      workspaceAccessPolicy: undefined,
    })
  })

  it('narrows writes while preserving the Agent read roots', () => {
    expect(resolveConversationFileScope(policy, '/Projects/Exam')).toEqual({
      explicitWorkingDirectory: '/Projects/Exam',
      workingDirectory: '/Projects/Exam',
      workspaceAccessPolicy: {
        enabled: true,
        workspaceRoot: '/Projects/Exam',
        readExtraIncludes: ['/Projects', '/References'],
        readExcludes: ['/Projects/private'],
        writeExcludes: ['/Projects/locked'],
        protectedPaths: [
          { kind: 'prefix', path: '/YOLO' },
          { kind: 'namePrefix', dir: '/', name: 'sessions.sqlite' },
        ],
      },
    })
  })

  it('keeps the whole Vault readable when only a conversation directory is set', () => {
    expect(resolveConversationFileScope(undefined, '/Projects/Exam')).toEqual({
      explicitWorkingDirectory: '/Projects/Exam',
      workingDirectory: '/Projects/Exam',
      workspaceAccessPolicy: {
        enabled: true,
        workspaceRoot: '/Projects/Exam',
        readExtraIncludes: ['/'],
        readExcludes: [],
        writeExcludes: [],
      },
    })
  })

  it('distinguishes an explicit Vault root from inheritance', () => {
    expect(resolveConversationFileScope(undefined, '/')).toEqual({
      explicitWorkingDirectory: '/',
      workingDirectory: '/',
      workspaceAccessPolicy: {
        enabled: true,
        workspaceRoot: '/',
        readExtraIncludes: [],
        readExcludes: [],
        writeExcludes: [],
      },
    })
  })

  it('rejects a directory outside the Agent write root', () => {
    expect(isAgentCompatibleWithDirectory(policy, '/Other')).toEqual({
      ok: false,
      reason: 'not_writable',
    })
  })

  it('rejects directories denied for reads or writes', () => {
    expect(isAgentCompatibleWithDirectory(policy, '/Projects/private')).toEqual(
      { ok: false, reason: 'not_readable' },
    )
    expect(isAgentCompatibleWithDirectory(policy, '/Projects/locked')).toEqual({
      ok: false,
      reason: 'not_writable',
    })
  })

  it('returns normalized compatible directories', () => {
    expect(isAgentCompatibleWithDirectory(policy, 'Projects/Exam/')).toEqual({
      ok: true,
      directory: '/Projects/Exam',
    })
  })

  it('rejects invalid conversation directories', () => {
    expect(isAgentCompatibleWithDirectory(policy, '../Other')).toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(() => normalizeConversationWorkingDirectory('C:/Other')).toThrow(
      'Invalid path',
    )
  })

  it('locks only after a user message is present', () => {
    expect(isConversationFileScopeLocked([])).toBe(false)
    expect(
      isConversationFileScopeLocked([{ role: 'assistant' }, { role: 'tool' }]),
    ).toBe(false)
    expect(
      isConversationFileScopeLocked([{ role: 'assistant' }, { role: 'user' }]),
    ).toBe(true)
  })

  it('keeps a durable file scope marker locked without user messages', () => {
    const isLocked = isConversationFileScopeLocked as (
      messages: Parameters<typeof isConversationFileScopeLocked>[0],
      fileScopeLocked?: boolean,
    ) => boolean

    expect(isLocked([], true)).toBe(true)
    expect(isLocked([{ role: 'assistant' }], true)).toBe(true)
  })

  it('keeps empty conversations without a durable marker editable', () => {
    const isLocked = isConversationFileScopeLocked as (
      messages: Parameters<typeof isConversationFileScopeLocked>[0],
      fileScopeLocked?: boolean,
    ) => boolean

    expect(isLocked([], false)).toBe(false)
    expect(isLocked([], undefined)).toBe(false)
  })
})
