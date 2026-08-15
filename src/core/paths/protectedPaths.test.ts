import type { WorkspaceAccessPolicy } from '../../types/assistant.types'
import type { YoloSettingsLike } from '../../types/yoloSettingsLike'

import {
  augmentWorkspacePolicyWithProtectedPaths,
  getProtectedVaultPathRules,
  isProtectedVaultPath,
} from './protectedPaths'

const defaultSettings = {} as unknown as YoloSettingsLike

const customSettings = (yolo: { baseDir?: string }) =>
  ({ yolo }) as unknown as YoloSettingsLike

describe('getProtectedVaultPathRules', () => {
  it('blanket-protects the whole baseDir minus skill paths, plus the sync pointer', () => {
    const rules = getProtectedVaultPathRules(defaultSettings)
    expect(rules).toEqual([
      { kind: 'prefix', path: 'YOLO' },
      { kind: 'except', path: 'YOLO/skills' },
      { kind: 'except', path: 'YOLO/snippets.md' },
      { kind: 'exact', path: '.yolo_sync' },
    ])
  })

  it('derives the blanket from the current baseDir setting', () => {
    const rules = getProtectedVaultPathRules(
      customSettings({ baseDir: 'Config/YoloData' }),
    )
    expect(rules).toEqual(
      expect.arrayContaining([
        { kind: 'prefix', path: 'Config/YoloData' },
        { kind: 'except', path: 'Config/YoloData/skills' },
        { kind: 'exact', path: '.yolo_sync' },
      ]),
    )
  })

  it('augments a policy with the generated rules', () => {
    const policy: WorkspaceAccessPolicy = {
      enabled: true,
      workspaceRoot: '/Notes',
      readExtraIncludes: [],
      readExcludes: [],
      writeExcludes: [],
    }
    const augmented = augmentWorkspacePolicyWithProtectedPaths(
      policy,
      defaultSettings,
    )
    expect(augmented?.protectedPaths).toEqual(
      getProtectedVaultPathRules(defaultSettings),
    )
    expect(augmented?.workspaceRoot).toBe('/Notes')
  })

  it('augments a missing policy with a disabled one carrying the rules', () => {
    const augmented = augmentWorkspacePolicyWithProtectedPaths(
      undefined,
      defaultSettings,
    )
    expect(augmented?.enabled).toBe(false)
    expect(augmented?.protectedPaths).toEqual(
      getProtectedVaultPathRules(defaultSettings),
    )
  })
})

describe('isProtectedVaultPath', () => {
  const rules = getProtectedVaultPathRules(defaultSettings)

  it('protects everything under the baseDir', () => {
    expect(isProtectedVaultPath('YOLO', rules)).toBe(true)
    expect(isProtectedVaultPath('YOLO/agent.sqlite', rules)).toBe(true)
    expect(isProtectedVaultPath('YOLO/share-token-pepper', rules)).toBe(true)
    expect(isProtectedVaultPath('YOLO/Projects/proj-a/project.md', rules)).toBe(
      true,
    )
    expect(isProtectedVaultPath('YOLO/data/chats/chat_index.json', rules)).toBe(
      true,
    )
  })

  it('carves skill-related paths out of the blanket', () => {
    expect(isProtectedVaultPath('YOLO/skills', rules)).toBe(false)
    expect(isProtectedVaultPath('YOLO/skills/review/SKILL.md', rules)).toBe(
      false,
    )
    expect(isProtectedVaultPath('YOLO/snippets.md', rules)).toBe(false)
  })

  it('protects the vault-root sync pointer and ignores unrelated content', () => {
    expect(isProtectedVaultPath('.yolo_sync', rules)).toBe(true)
    expect(isProtectedVaultPath('notes/plain.md', rules)).toBe(false)
    expect(isProtectedVaultPath('', rules)).toBe(false)
  })

  it('handles vault-root addressing with a leading slash', () => {
    expect(isProtectedVaultPath('/YOLO/sessions.sqlite', rules)).toBe(true)
    expect(isProtectedVaultPath('/YOLO/skills/review/SKILL.md', rules)).toBe(
      false,
    )
    expect(isProtectedVaultPath('/notes/plain.md', rules)).toBe(false)
  })

  it('returns false when rules are absent', () => {
    expect(isProtectedVaultPath('YOLO/sessions.sqlite', undefined)).toBe(false)
    expect(isProtectedVaultPath('YOLO/sessions.sqlite', [])).toBe(false)
  })
})
