/**
 * One-shot repair: append backup-only `.yolo-*` selector blocks from the
 * pre-rollback branch into the current stylesheet files. Only blocks whose
 * selector is entirely absent from the current file are appended, so already
 * migrated or intentionally reworked styles are untouched. Run manually when
 * a UI surface renders unstyled after a migration.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const BRANCH = 'backup/pre-rollback-2026-08-10'
const STYLE_DIR = 'src/styles'

const backupFile = (path) =>
  execFileSync('git', ['show', `${BRANCH}:${path}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

/** Splits css into top-level rules, returning { selector, body } per rule. */
function splitTopLevelRules(css) {
  const rules = []
  let depth = 0
  let ruleStart = 0
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i]
    if (ch === '{') {
      if (depth === 0) {
        rules.push({ selector: css.slice(ruleStart, i).trim(), bodyStart: i + 1 })
      }
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const rule = rules[rules.length - 1]
        rule.body = css.slice(rule.bodyStart, i)
        ruleStart = i + 1
      }
    }
  }
  return rules
}

const cssFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', BRANCH, STYLE_DIR], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter((path) => path.endsWith('.css'))

let totalAppended = 0
for (const path of cssFiles) {
  let current
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    continue // file was removed in the current tree; not our concern here
  }
  const backup = backupFile(path)
  const missingBlocks = []
  for (const rule of splitTopLevelRules(backup)) {
    if (!rule.selector.includes('.yolo-')) continue
    if (current.includes(rule.selector)) continue
    missingBlocks.push(`${rule.selector} {\n${rule.body.trimEnd()}\n}\n`)
  }
  if (missingBlocks.length > 0) {
    const suffix = `\n/* Restored from ${BRANCH} (migration gap) */\n`
    writeFileSync(path, current.trimEnd() + '\n' + suffix + missingBlocks.join('\n'))
    console.log(`${path}: +${missingBlocks.length} blocks`)
    totalAppended += missingBlocks.length
  }
}
console.log(`total appended blocks: ${totalAppended}`)
