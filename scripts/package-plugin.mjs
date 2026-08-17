import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const defaultOutputDir = path.join(repositoryRoot, 'dist', 'smart-rag')
const rootArtifacts = ['main.js', 'manifest.json', 'styles.css']
const sourceDirectoryNames = new Set(['src', 'node_modules'])

export async function packagePlugin({
  rootDir = repositoryRoot,
  outputDir = path.join(rootDir, 'dist', 'smart-rag'),
} = {}) {
  const root = path.resolve(rootDir)
  const output = path.resolve(outputDir)

  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })

  for (const artifact of rootArtifacts) {
    await copyRequiredFile(
      path.join(root, artifact),
      path.join(output, artifact),
    )
  }

  await copyCompiledDirectory(
    path.join(root, 'web-ui'),
    path.join(output, 'web-ui'),
  )
  await packageBundledModules(root, output)
  await packageRuntimeComponents(root, output)

  const files = await listFiles(output)
  assertNoSourceFiles(files)
  console.log(`[plugin] Packaged ${files.length} files → ${output}`)
  return { outputDir: output, files }
}

async function packageBundledModules(root, output) {
  const sourceRoot = path.join(root, 'modules')
  const targetRoot = path.join(output, 'modules')
  const indexPath = path.join(sourceRoot, 'bundled.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))

  if (!index || index.schemaVersion !== 1 || !Array.isArray(index.modules)) {
    throw new Error('modules/bundled.json is invalid')
  }

  await copyRequiredFile(indexPath, path.join(targetRoot, 'bundled.json'))
  for (const module of index.modules) {
    assertPathSegment(module.id, 'module id')
    assertPathSegment(module.version, 'module version')
    const moduleRoot = path.join(sourceRoot, module.id, module.version)
    const manifestPath = path.join(moduleRoot, 'module.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const artifactPaths = new Set(['module.json'])

    for (const variant of manifest.variants ?? []) {
      for (const file of variant.files ?? []) {
        if (typeof file.path !== 'string') {
          throw new Error(`Module ${module.id} has an invalid artifact path`)
        }
        artifactPaths.add(assertSafeRelativePath(file.path))
      }
    }

    for (const artifactPath of artifactPaths) {
      await copyRequiredFile(
        path.join(moduleRoot, artifactPath),
        path.join(targetRoot, module.id, module.version, artifactPath),
      )
    }
  }
}

async function packageRuntimeComponents(root, output) {
  const registryPath = path.join(root, 'runtime-components', 'registry.json')
  const registry = JSON.parse(await readFile(registryPath, 'utf8'))

  if (
    !registry ||
    registry.schemaVersion !== 1 ||
    !Array.isArray(registry.components)
  ) {
    throw new Error('runtime-components/registry.json is invalid')
  }

  await copyRequiredFile(
    registryPath,
    path.join(output, 'runtime-components', 'registry.json'),
  )
  for (const component of registry.components) {
    if (typeof component.entry !== 'string') {
      throw new Error('Runtime component entry is invalid')
    }
    const entryPath = assertSafeRelativePath(component.entry)
    if (!entryPath.startsWith('runtime-components/')) {
      throw new Error(
        `Runtime component entry escapes its directory: ${entryPath}`,
      )
    }
    await copyRequiredFile(
      path.join(root, entryPath),
      path.join(output, entryPath),
    )
  }
}

async function copyCompiledDirectory(source, target) {
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (sourceDirectoryNames.has(entry.name)) {
      throw new Error(
        `Source directory found in compiled output: ${entry.name}`,
      )
    }
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)
    if (entry.isDirectory()) {
      await copyCompiledDirectory(sourcePath, targetPath)
    } else if (entry.isFile()) {
      await copyRequiredFile(sourcePath, targetPath)
    }
  }
}

async function copyRequiredFile(source, target) {
  await mkdir(path.dirname(target), { recursive: true })
  await copyFile(source, target)
}

async function listFiles(root) {
  const files = []
  const pending = ['']
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()
    const absoluteDirectory = path.join(root, relativeDirectory)
    const entries = await readdir(absoluteDirectory, { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name)
      if (entry.isDirectory()) {
        pending.push(relativePath)
      } else if (entry.isFile()) {
        files.push(relativePath)
      }
    }
  }
  return files.sort()
}

function assertNoSourceFiles(files) {
  for (const file of files) {
    const segments = file.split('/')
    if (
      segments.some((segment) => sourceDirectoryNames.has(segment)) ||
      /\.(?:ts|tsx|jsx|map)$/.test(file)
    ) {
      throw new Error(`Source file leaked into plugin package: ${file}`)
    }
  }
}

function assertSafeRelativePath(value) {
  const normalized = value.replaceAll('\\', '/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    path.posix.isAbsolute(normalized) ||
    normalized
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe artifact path: ${value}`)
  }
  return normalized
}

function assertPathSegment(value, label) {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await packagePlugin({ outputDir: defaultOutputDir })
}
