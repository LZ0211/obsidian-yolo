import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const moduleId = 'workflow'
const moduleRoot = path.join(repositoryRoot, 'modules', moduleId)
const sourceRoot = path.join(moduleRoot, 'src')
const forbiddenSourceRoots = [
  path.join(repositoryRoot, 'src', 'core'),
  path.join(repositoryRoot, 'src', 'components'),
]
const declaredProductionPackages = ['ajv', 'lucide-react', 'react']

test('declares the Workflow production dependencies', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(moduleRoot, 'package.json'), 'utf8'),
  )
  assert.deepEqual(
    Object.keys(packageJson.dependencies ?? {}).sort(),
    declaredProductionPackages,
  )
})

test('keeps Workflow production imports behind the module boundary', async () => {
  const imports = await readImports(sourceRoot)
  for (const { filePath, statement, specifier } of imports) {
    const relativePath = path.relative(repositoryRoot, filePath)
    assert.notEqual(specifier, 'obsidian', `${relativePath} imports obsidian`)
    assert.doesNotMatch(
      statement,
      /\bYoloPlugin\b/,
      `${relativePath} imports YoloPlugin`,
    )

    const normalizedSpecifier = specifier.replaceAll('\\', '/')
    assert.doesNotMatch(
      normalizedSpecifier,
      /(^|\/)src\/(core|components)(\/|$)/,
      `${relativePath} imports ${specifier}`,
    )
    if (specifier.startsWith('.')) {
      const resolvedImport = path.resolve(path.dirname(filePath), specifier)
      assert.equal(
        forbiddenSourceRoots.some(
          (root) =>
            resolvedImport === root ||
            resolvedImport.startsWith(`${root}${path.sep}`),
        ),
        false,
        `${relativePath} imports ${specifier}`,
      )
    }
  }
})

test('keeps Core out of the Workflow entry metafile', async () => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), 'workflow-module-boundary-'),
  )
  const artifactDir = path.join(fixtureRoot, 'artifact')
  const metafilePath = path.join(fixtureRoot, 'metafile.json')
  try {
    await execFileAsync(
      process.execPath,
      [
        'scripts/build-first-party-modules.mjs',
        '--module',
        moduleId,
        '--output-dir',
        artifactDir,
        '--metafile-output',
        metafilePath,
      ],
      { cwd: repositoryRoot },
    )
    const metafile = JSON.parse(await readFile(metafilePath, 'utf8'))
    assert.deepEqual(metafile.entryImports, [])
    assert.equal(
      metafile.inputs.some((input) =>
        /(^|\/)src\/core\//.test(input.replaceAll('\\', '/')),
      ),
      false,
    )
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('ships every declared Workflow data file', async () => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), 'workflow-module-datafiles-'),
  )
  const artifactDir = path.join(fixtureRoot, 'artifact')
  try {
    await execFileAsync(
      process.execPath,
      [
        'scripts/build-first-party-modules.mjs',
        '--module',
        moduleId,
        '--output-dir',
        artifactDir,
      ],
      { cwd: repositoryRoot },
    )
    const config = JSON.parse(
      await readFile(path.join(moduleRoot, 'module.config.json'), 'utf8'),
    )
    const manifest = JSON.parse(
      await readFile(path.join(artifactDir, 'module.json'), 'utf8'),
    )
    for (const variant of manifest.variants) {
      const dataFiles = variant.files
        .filter(({ role }) => role === 'data')
        .map(({ path: filePath }) => filePath)
        .sort()
      assert.deepEqual(dataFiles, [...config.dataFiles].sort())
      for (const filePath of config.dataFiles) {
        await readFile(path.join(artifactDir, filePath))
      }
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

async function readImports(root) {
  const imports = []
  for (const filePath of await listSourceFiles(root)) {
    if (/\.(?:test|fixture)\.[cm]?[jt]sx?$/.test(filePath)) continue
    const source = await readFile(filePath, 'utf8')
    const importPattern =
      /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    for (const match of source.matchAll(importPattern)) {
      imports.push({
        filePath,
        specifier: match[1] ?? match[2],
        statement: match[0],
      })
    }
  }
  return imports
}

async function listSourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listSourceFiles(entryPath)))
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(entryPath)
  }
  return files
}
