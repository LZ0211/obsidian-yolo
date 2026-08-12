import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('SkillSlashPlugin slash commands', () => {
  const source = readFileSync(join(__dirname, 'SkillSlashPlugin.tsx'), 'utf8')

  it('keeps /compact-context on its callback path', () => {
    expect(source).toContain("const COMPACT_COMMAND_ID = 'compact-context'")
    expect(source).toMatch(
      /id: typeof COMPACT_COMMAND_ID[\s\S]*?name: string[\s\S]*?description: string\s*\}/,
    )
    expect(source).toContain('onRunCommand?.(payload.command)')
  })
})
