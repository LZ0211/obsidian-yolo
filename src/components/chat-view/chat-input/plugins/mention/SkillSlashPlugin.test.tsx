import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('SkillSlashPlugin slash commands', () => {
  const source = readFileSync(join(__dirname, 'SkillSlashPlugin.tsx'), 'utf8')

  it('keeps /compact-context on its callback path', () => {
    expect(source).toContain("'compact-context'")
    expect(source).toContain('onRunCommand?.(payload.command)')
  })
})
