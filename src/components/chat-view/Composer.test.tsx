import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Composer platform visibility', () => {
  const source = readFileSync(join(__dirname, 'Composer.tsx'), 'utf8')

  it('removed the RAG settings shortcut and its knowledge-base entry', () => {
    expect(source).not.toContain('shouldRenderKnowledgeSettingsShortcut')
    expect(source).not.toContain('app.setting.openTabById')
  })
})
