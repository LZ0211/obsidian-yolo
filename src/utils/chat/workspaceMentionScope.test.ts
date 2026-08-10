import type { WorkspaceAccessPolicy } from '../../types/assistant.types'

import { isMentionableInWorkspaceScope } from './workspaceMentionScope'

const homePolicy: WorkspaceAccessPolicy = {
  enabled: true,
  workspaceRoot: '04-专利',
  readExtraIncludes: ['00-Email'],
  readExcludes: ['04-专利/secret'],
  writeExcludes: [],
}

const fileMention = (path: string) =>
  ({ type: 'file', file: { path } }) as never

const folderMention = (path: string) =>
  ({ type: 'folder', folder: { path } }) as never

describe('isMentionableInWorkspaceScope', () => {
  it('shows everything when no policy is enabled', () => {
    expect(isMentionableInWorkspaceScope(fileMention('any.md'), undefined)).toBe(
      true,
    )
    expect(isMentionableInWorkspaceScope(folderMention('any'), undefined)).toBe(
      true,
    )
  })

  it('shows files inside home and read-extra includes', () => {
    expect(
      isMentionableInWorkspaceScope(fileMention('04-专利/a.md'), homePolicy),
    ).toBe(true)
    expect(
      isMentionableInWorkspaceScope(fileMention('04-专利/sub/b.md'), homePolicy),
    ).toBe(true)
    expect(
      isMentionableInWorkspaceScope(fileMention('00-Email/c.md'), homePolicy),
    ).toBe(true)
  })

  it('hides files outside home and read-extra includes', () => {
    expect(
      isMentionableInWorkspaceScope(fileMention('03-分子数据库/a.md'), homePolicy),
    ).toBe(false)
  })

  it('hides files inside read-excludes even when within home', () => {
    expect(
      isMentionableInWorkspaceScope(fileMention('04-专利/secret/x.md'), homePolicy),
    ).toBe(false)
  })

  it('shows folders inside home', () => {
    expect(
      isMentionableInWorkspaceScope(folderMention('04-专利/sub'), homePolicy),
    ).toBe(true)
  })

  it('shows folders that are ancestors of home (so the user can navigate down)', () => {
    const nestedHome: WorkspaceAccessPolicy = {
      ...homePolicy,
      workspaceRoot: '04-专利/01-锂电',
    }
    expect(
      isMentionableInWorkspaceScope(folderMention('04-专利'), nestedHome),
    ).toBe(true)
  })

  it('hides folders entirely outside the scoped area', () => {
    expect(
      isMentionableInWorkspaceScope(folderMention('05-知识库'), homePolicy),
    ).toBe(false)
  })

  it('shows non-path mentionables unconditionally', () => {
    expect(
      isMentionableInWorkspaceScope(
        { type: 'assistant-quote', content: 'x' } as never,
        homePolicy,
      ),
    ).toBe(true)
  })
})
