/**
 * Web 端 e2e harness 专用 jest 配置。
 *
 * 与主 jest.config.js 的区别：
 * - rootDir 指向仓库根（复用主配置的 transform/setup/moduleNameMapper 基建）；
 * - roots 收窄到本目录，testMatch 只跑 harness-server.test.ts
 *   （e2e.spec.ts 是 Playwright spec，不能进 jest）；
 * - obsidian 映射到本目录的 obsidian-stub.ts（Node 环境运行时符号 stub），
 *   而不是 __mocks__/obsidian.ts（那是 jest.fn 形态，缺 getLanguage 等）。
 */
const base = require('../../jest.config.js')

module.exports = {
  ...base,
  rootDir: '../..',
  roots: ['<rootDir>/scripts/qa-web-harness'],
  testMatch: ['**/harness-server.test.ts'],
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '^obsidian$': '<rootDir>/scripts/qa-web-harness/obsidian-stub.ts',
  },
}
