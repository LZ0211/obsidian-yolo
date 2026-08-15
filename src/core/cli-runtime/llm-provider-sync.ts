import { Platform } from 'obsidian'

import type { YoloSettingsLike } from '../../types/yoloSettingsLike'

import { resolveLlmInjection } from './llm-injection'

/**
 * 全局配置文件同步（cc-switch 式）：codex 与 opencode 的 provider 配置只能
 * 通过各自的全局配置文件注入（~/.codex/config.toml、~/.config/opencode/
 * opencode.json）。开关开启且选择变化时原子写入（带持久化备份），关闭时
 * 恢复备份。桌面专用（node:fs 在 Platform.isDesktop 门后动态 import）。
 */

const BACKUP_SUFFIX = '.yolo-backup'
const LAST_APPLIED_KEY = 'yolo-cli-llm-injection-last-applied'
const OPENCODE_PROVIDER_ID = 'yolo'

async function loadFs(): Promise<{
  fs: typeof import('node:fs/promises')
  path: typeof import('node:path')
}> {
  // eslint-disable-next-line import/no-nodejs-modules -- desktop-only
  const fs = await import('node:fs/promises')
  // eslint-disable-next-line import/no-nodejs-modules -- desktop-only
  const path = await import('node:path')
  return { fs, path }
}

async function resolveHomeDir(): Promise<string> {
  // eslint-disable-next-line import/no-nodejs-modules -- desktop-only
  const { homedir } = await import('node:os')
  return homedir()
}

async function atomicWriteWithBackup(
  configPath: string,
  content: string,
): Promise<void> {
  const { fs, path } = await loadFs()
  const dir = path.dirname(configPath)
  await fs.mkdir(dir, { recursive: true })

  let old: string | null = null
  try {
    old = await fs.readFile(configPath, 'utf8')
  } catch {
    old = null
  }

  const tmpPath = `${configPath}.tmp-${Date.now()}`
  await fs.writeFile(tmpPath, content, 'utf8')
  try {
    await fs.rename(tmpPath, configPath)
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined)
    if (old !== null) {
      await fs.writeFile(configPath, old, 'utf8').catch(() => undefined)
    }
    throw error
  }

  const backupPath = `${configPath}${BACKUP_SUFFIX}`
  try {
    await fs.access(backupPath)
  } catch {
    await fs.writeFile(backupPath, old ?? '', 'utf8')
  }
}

async function restoreFromBackup(configPath: string): Promise<boolean> {
  const { fs } = await loadFs()
  const backupPath = `${configPath}${BACKUP_SUFFIX}`
  try {
    const backup = await fs.readFile(backupPath, 'utf8')
    await fs.rm(configPath, { force: true, recursive: true })
    if (backup) await fs.writeFile(configPath, backup, 'utf8')
    await fs.rm(backupPath, { force: true }).catch(() => undefined)
    return true
  } catch {
    return false
  }
}

async function resolveCodexConfigPath(
  configDirOverride?: string,
): Promise<string> {
  if (configDirOverride) return `${configDirOverride}/config.toml`
  const codexHome = process.env.CODEX_HOME?.trim()
  const dir = codexHome || `${await resolveHomeDir()}/.codex`
  return `${dir}/config.toml`
}

async function resolveOpenCodeConfigPath(
  configDirOverride?: string,
): Promise<string> {
  if (configDirOverride) return `${configDirOverride}/opencode.json`
  return `${await resolveHomeDir()}/.config/opencode/opencode.json`
}

/** 抄 cc-switch generateThirdPartyConfig：第三方供应商的 Codex config.toml。 */
export function generateCodexConfig(
  providerName: string,
  baseUrl: string,
  modelName: string,
): string {
  const tomlString = (value: string) => JSON.stringify(value)
  return `model_provider = "yolo"
model = ${tomlString(modelName)}
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.yolo]
name = ${tomlString(providerName)}
base_url = ${tomlString(baseUrl)}
wire_api = "responses"
requires_openai_auth = true`
}

/** opencode.json 的 provider 段（cc-switch OpenCodeProviderConfig 形状）。 */
export function buildOpenCodeProviderEntry(
  providerName: string,
  baseUrl: string,
  apiKey: string,
  modelName: string,
  npm: string,
): Record<string, unknown> {
  return {
    npm,
    name: providerName,
    options: { apiKey, baseURL: baseUrl },
    models: { [modelName]: { name: modelName } },
  }
}

async function writeOpenCodeProvider(
  configPath: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const { fs } = await loadFs()
  let current: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>
    }
  } catch {
    current = {}
  }
  const providers =
    current.provider && typeof current.provider === 'object'
      ? (current.provider as Record<string, unknown>)
      : {}
  const next = {
    ...current,
    provider: { ...providers, [OPENCODE_PROVIDER_ID]: entry },
  }
  await atomicWriteWithBackup(
    configPath,
    `${JSON.stringify(next, null, 2)}\n`,
  )
}

async function removeOpenCodeProvider(configPath: string): Promise<void> {
  const { fs } = await loadFs()
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const current = parsed as Record<string, unknown>
    const providers =
      current.provider && typeof current.provider === 'object'
        ? (current.provider as Record<string, unknown>)
        : null
    if (!providers || !(OPENCODE_PROVIDER_ID in providers)) return
    const nextProviders = { ...providers }
    delete nextProviders[OPENCODE_PROVIDER_ID]
    await atomicWriteWithBackup(
      configPath,
      `${JSON.stringify({ ...current, provider: nextProviders }, null, 2)}\n`,
    )
  } catch {
    // 无文件/解析失败：无需清理。
  }
}

export type LlmProviderSync = {
  /** 依据当前设置应用/恢复全局配置；返回是否发生了写入。 */
  apply(): Promise<boolean>
}

export function createLlmProviderSync(input: {
  app: { loadLocalStorage: (key: string) => unknown; saveLocalStorage: (key: string, value: unknown) => void }
  getSettings: () => YoloSettingsLike | null
  injection?: () => { enabled: boolean; providerId?: string; modelId?: string } | null | undefined
  configDirOverride?: string
}): LlmProviderSync {
  const readSignature = (): string | null => {
    const value = input.app.loadLocalStorage(LAST_APPLIED_KEY)
    return typeof value === 'string' && value ? value : null
  }
  const writeSignature = (value: string | null): void => {
    input.app.saveLocalStorage(LAST_APPLIED_KEY, value)
  }

  return {
    apply: async (): Promise<boolean> => {
      if (!Platform.isDesktop) return false
      const injection = input.injection?.() ?? undefined
      const resolved = resolveLlmInjection({
        injection,
        getSettings: input.getSettings,
      })
      const signature = resolved
        ? `on:${resolved.provider.id}:${resolved.model.id}`
        : 'off'
      if (signature === readSignature()) return false

      const codexPath = await resolveCodexConfigPath(input.configDirOverride)
      const opencodePath = await resolveOpenCodeConfigPath(
        input.configDirOverride,
      )

      if (!resolved) {
        await Promise.allSettled([
          restoreFromBackup(codexPath),
          restoreFromBackup(opencodePath),
          removeOpenCodeProvider(opencodePath),
        ])
        writeSignature('off')
        return true
      }

      const { provider, model } = resolved
      const baseUrl = provider.baseUrl ?? ''
      const modelName = model.model.trim() || 'gpt-5.6-sol'

      // codex：Responses 兼容（apiType=openai-responses 或模型显式支持）才写。
      const providerApiType = (provider as { apiType?: string }).apiType
      const responsesSupported =
        providerApiType === 'openai-responses' ||
        (model as { codexResponsesSupported?: boolean })
          .codexResponsesSupported === true
      if (responsesSupported && baseUrl) {
        await atomicWriteWithBackup(
          codexPath,
          generateCodexConfig(provider.name ?? provider.id, baseUrl, modelName),
        )
      }

      // opencode：Anthropic 兼容走 @ai-sdk/anthropic，其余 @ai-sdk/openai-compatible。
      const anthropicLike = providerApiType === 'anthropic'
      const npm = anthropicLike
        ? '@ai-sdk/anthropic'
        : '@ai-sdk/openai-compatible'
      await writeOpenCodeProvider(
        opencodePath,
        buildOpenCodeProviderEntry(
          provider.name ?? provider.id,
          baseUrl,
          provider.apiKey ?? '',
          modelName,
          npm,
        ),
      )

      writeSignature(signature)
      return true
    },
  }
}
