import { validateScriptPath } from './validateScriptPath'

const enabled = { enableScriptExecution: true, allowedScriptDirectories: [] }

describe('validateScriptPath', () => {
  it('rejects when script execution is disabled', () => {
    const result = validateScriptPath('scripts/run.js', {
      enableScriptExecution: false,
      allowedScriptDirectories: [],
    })
    expect(result?.code).toBe('execution_disabled')
  })

  it.each([
    ['C:\\scripts\\run.js'],
    ['C:/scripts/run.js'],
    ['/etc/passwd'],
    ['\\\\server\\share\\run.js'],
  ])('rejects the absolute path %s', (scriptPath) => {
    const result = validateScriptPath(scriptPath, enabled)
    expect(result?.code).toBe('absolute_path')
  })

  it('rejects a path that escapes the vault via ../', () => {
    const result = validateScriptPath('scripts/../../etc/run.js', enabled)
    expect(result?.code).toBe('path_escape')
  })

  it('allows any vault-relative path when allowedScriptDirectories is empty', () => {
    expect(validateScriptPath('run.js', enabled)).toBeNull()
    expect(validateScriptPath('scripts/run.js', enabled)).toBeNull()
  })

  it('rejects a path outside the configured allowlist', () => {
    const settings = {
      enableScriptExecution: true,
      allowedScriptDirectories: ['scripts', 'automation'],
    }
    const result = validateScriptPath('other/run.js', settings)
    expect(result?.code).toBe('outside_allowlist')
  })

  it('allows a path inside a configured allowlist directory', () => {
    const settings = {
      enableScriptExecution: true,
      allowedScriptDirectories: ['scripts', 'automation'],
    }
    expect(validateScriptPath('scripts/run.js', settings)).toBeNull()
    expect(validateScriptPath('automation/nested/run.js', settings)).toBeNull()
  })
})
