// Mock for virtual:* modules (esbuild virtual modules not available in Jest).
// virtual:sql-js-wasm carries the inlined sql.js wasm as base64; Jest loads
// the real binary so sqlite-js runtime tests exercise the actual engine.
import { readFileSync } from 'node:fs'

const wasmBase64 = readFileSync(
  require.resolve('sql.js/dist/sql-wasm.wasm'),
).toString('base64')

export default wasmBase64
