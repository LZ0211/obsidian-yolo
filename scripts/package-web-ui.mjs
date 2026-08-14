import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as JSZipModule from 'jszip'

const JSZip = JSZipModule.default ?? JSZipModule
const [sourceDirArg, outputFileArg] = process.argv.slice(2)

if (!sourceDirArg || !outputFileArg) {
  throw new Error(
    'Usage: node scripts/package-web-ui.mjs <source-dir> <output>',
  )
}

const sourceDir = path.resolve(sourceDirArg)
const outputFile = path.resolve(outputFileArg)
const zip = new JSZip()

async function addDirectory(directory, relativeDirectory = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolutePath = path.join(directory, entry.name)
    const relativePath = path.posix.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) {
      await addDirectory(absolutePath, relativePath)
      continue
    }
    if (!entry.isFile()) continue
    zip.file(relativePath, await readFile(absolutePath))
  }
}

if (!(await stat(sourceDir)).isDirectory()) {
  throw new Error(`Web UI source directory is invalid: ${sourceDir}`)
}

await addDirectory(sourceDir)
await mkdir(path.dirname(outputFile), { recursive: true })
await writeFile(
  outputFile,
  await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  }),
)
console.log(`[web-ui] Packaged ${sourceDir} → ${outputFile}`)
