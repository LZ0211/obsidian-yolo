import type { WorkspaceAccessPolicy } from '../../types/assistant.types'
import type { YoloSettingsLike } from '../../types/yoloSettingsLike'

import {
  augmentWorkspacePolicyWithProtectedPaths,
  getProtectedVaultPathRules,
  isProtectedVaultPath,
} from './protectedPaths'

const defaultSettings = {} as unknown as YoloSettingsLike

const customSettings = (yolo: { baseDir?: string; projectsDir?: string }) =>
  ({ yolo }) as unknown as YoloSettingsLike

describe('getProtectedVaultPathRules', () => {
  it('covers plugin-private baseDir data, the sync pointer, and the project zone', () => {
    const rules = getProtectedVaultPathRules(defaultSettings)
    const prefixPaths = rules
      .filter(
        (rule): rule is { kind: 'prefix'; path: string } =>
          rule.kind === 'prefix',
      )
      .map((rule) => rule.path)
    const exactPaths = rules
      .filter(
        (rule): rule is { kind: 'exact'; path: string } =>
          rule.kind === 'exact',
      )
      .map((rule) => rule.path)
    expect(prefixPaths).toEqual(
      expect.arrayContaining(['YOLO/.yolo_json_db', 'YOLO/memory', 'Projects']),
    )
    expect(exactPaths).toEqual(
      expect.arrayContaining([
        'YOLO/.yolo_data.json',
        'YOLO/sessions.sqlite',
        'YOLO/conversation.sqlite',
        'YOLO/scheduled-tasks.sqlite',
        'YOLO/.yolo_vector_db.tar.gz',
        '.yolo_sync',
      ]),
    )
  })

  it('derives the deny set from current baseDir and projectsDir settings', () => {
    const rules = getProtectedVaultPathRules(
      customSettings({
        baseDir: 'Config/YoloData',
        projectsDir: 'Work/Projects',
      }),
    )
    const paths = rules
      .filter(
        (rule): rule is { kind: 'prefix' | 'exact'; path: string } =>
          rule.kind === 'prefix' || rule.kind === 'exact',
      )
      .map((rule) => rule.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'Config/YoloData/.yolo_json_db',
        'Config/YoloData/.yolo_data.json',
        'Work/Projects',
      ]),
    )
  })
})

describe('isProtectedVaultPath', () => {
  const rules = getProtectedVaultPathRules(defaultSettings)

  it('denies plugin-private baseDir data', () => {
    expect(isProtectedVaultPath('YOLO/.yolo_data.json', rules)).toBe(true)
    expect(
      isProtectedVaultPath('YOLO/.yolo_json_db/chats/chat.json', rules),
    ).toBe(true)
    expect(isProtectedVaultPath('YOLO/.yolo_json_db', rules)).toBe(true)
    expect(isProtectedVaultPath('YOLO/sessions.sqlite', rules)).toBe(true)
    expect(isProtectedVaultPath('YOLO/conversation.sqlite', rules)).toBe(true)
    expect(isProtectedVaultPath('YOLO/scheduled-tasks.sqlite', rules)).toBe(
      true,
    )
    expect(isProtectedVaultPath('YOLO/memory/index.sqlite', rules)).toBe(true)
    expect(isProtectedVaultPath('YOLO/.yolo_vector_db.tar.gz', rules)).toBe(
      true,
    )
  })

  it('denies the vault-root sync pointer', () => {
    expect(isProtectedVaultPath('.yolo_sync', rules)).toBe(true)
  })

  it('denies the whole project zone', () => {
    expect(isProtectedVaultPath('Projects', rules)).toBe(true)
    expect(isProtectedVaultPath('Projects/proj-alpha/project.md', rules)).toBe(
      true,
    )
    expect(
      isProtectedVaultPath('Projects/proj-alpha/tasks/T-001.md', rules),
    ).toBe(true)
  })

  it('allows user content including skills, snippets, and learning', () => {
    expect(isProtectedVaultPath('YOLO/skills/review/SKILL.md', rules)).toBe(
      false,
    )
    expect(isProtectedVaultPath('YOLO/snippets.md', rules)).toBe(false)
    expect(isProtectedVaultPath('YOLO/learning/notes.md', rules)).toBe(false)
    expect(isProtectedVaultPath('notes/plain.md', rules)).toBe(false)
    expect(isProtectedVaultPath('', rules)).toBe(false)
  })

  it('handles vault-root addressing with a leading slash', () => {
    expect(isProtectedVaultPath('/Projects/proj-alpha/project.md', rules)).toBe(
      true,
    )
    expect(isProtectedVaultPath('/YOLO/sessions.sqlite', rules)).toBe(true)
    expect(isProtectedVaultPath('/notes/plain.md', rules)).toBe(false)
  })

  it('returns false for a protected path when rules are absent', () => {
    expect(isProtectedVaultPath('YOLO/sessions.sqlite', undefined)).toBe(false)
    expect(isProtectedVaultPath('YOLO/sessions.sqlite', [])).toBe(false)
  })

  it('respects a custom projectsDir', () => {
    const customRules = getProtectedVaultPathRules(
      customSettings({ projectsDir: 'Work/Projects' }),
    )
    expect(
      isProtectedVaultPath('Work/Projects/proj-x/project.md', customRules),
    ).toBe(true)
    expect(
      isProtectedVaultPath('Projects/proj-x/project.md', customRules),
    ).toBe(false)
  })
})

describe('augmentWorkspacePolicyWithProtectedPaths', () => {
  it('replaces any persisted protectedPaths with the current settings-derived rules (runtime injection wins)', () => {
    const stalePersisted: WorkspaceAccessPolicy = {
      enabled: true,
      workspaceRoot: '04-专利',
      readExtraIncludes: [],
      readExcludes: [],
      writeExcludes: [],
      // A stale value persisted through the schema (e.g. the baseDir moved
      // since it was saved). Must never reach the runtime.
      protectedPaths: [{ kind: 'prefix', path: 'OLD-BASE/sessions.sqlite' }],
    }

    const augmented = augmentWorkspacePolicyWithProtectedPaths(
      stalePersisted,
      defaultSettings,
    )

    expect(augmented?.protectedPaths).toEqual(
      getProtectedVaultPathRules(defaultSettings),
    )
    expect(
      isProtectedVaultPath('YOLO/sessions.sqlite', augmented?.protectedPaths),
    ).toBe(true)
    expect(
      isProtectedVaultPath(
        'OLD-BASE/sessions.sqlite',
        augmented?.protectedPaths,
      ),
    ).toBe(false)
  })

  it('keeps the rest of the policy untouched while attaching the rules', () => {
    const policy: WorkspaceAccessPolicy = {
      enabled: true,
      workspaceRoot: '04-专利',
      readExtraIncludes: ['00-Email'],
      readExcludes: [],
      writeExcludes: ['04-专利/archive'],
    }

    const augmented = augmentWorkspacePolicyWithProtectedPaths(
      policy,
      defaultSettings,
    )

    expect(augmented).toMatchObject({
      enabled: true,
      workspaceRoot: '04-专利',
      readExtraIncludes: ['00-Email'],
      writeExcludes: ['04-专利/archive'],
    })
  })

  it('creates a protection-only policy when no workspace policy exists', () => {
    expect(
      augmentWorkspacePolicyWithProtectedPaths(undefined, defaultSettings),
    ).toEqual({
      enabled: false,
      workspaceRoot: '',
      readExtraIncludes: [],
      readExcludes: [],
      writeExcludes: [],
      protectedPaths: getProtectedVaultPathRules(defaultSettings),
    })
  })
})
