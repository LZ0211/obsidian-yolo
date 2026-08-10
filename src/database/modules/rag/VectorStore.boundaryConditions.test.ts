import * as fs from 'node:fs'
import * as path from 'node:path'

const productionFiles = [
  'src/database/modules/rag/SqliteVectorStore.ts',
  'src/database/modules/rag/SqliteSchema.ts',
  'src/database/sqlite/sqliteNativeRuntime.ts',
  'src/database/modules/rag/VectorStoreFactory.ts',
]

const forbiddenTokens = [
  '@electric-sql/pglite',
  'PGlite',
  'pglite',
  'drizzle-orm/pglite',
  'drizzle-orm/pg-core',
  'embeddingTable',
  'dumpDataDir',
  'loadDataDir',
  'loadExtension',
  'sqlite-vec',
  'sqliteVec',
  'sqliteVecTestRuntime',
  'sqliteVecWasmFileRuntime',
  'sqlite-vec-browser-probe',
  'sqliteVecBrowser',
  'opfs',
  'OPFS',
]

const buildAndDependencyFiles = [
  'esbuild.config.mjs',
  'package.json',
  'tsconfig.json',
]

describe('VectorStore production boundary conditions', () => {
  it('keeps sqlite production files independent from PGlite, Drizzle, sqlite-vec, and experimental runtimes', () => {
    for (const relativePath of productionFiles) {
      const absolutePath = path.join(process.cwd(), relativePath)
      const content = fs.readFileSync(absolutePath, 'utf8')

      for (const token of forbiddenTokens) {
        expect(content).not.toContain(token)
      }
    }
  })

  it('does not retain retired database runtimes in build configuration or dependencies', () => {
    for (const relativePath of buildAndDependencyFiles) {
      const absolutePath = path.join(process.cwd(), relativePath)
      const content = fs.readFileSync(absolutePath, 'utf8')

      expect(content.toLowerCase()).not.toContain('pglite')
      expect(content.toLowerCase()).not.toContain('drizzle')
    }

    expect(
      fs.existsSync(path.join(process.cwd(), 'import-meta-url-shim.js')),
    ).toBe(false)
  })
})
