import { normalizeConversationWorkingDirectory } from '../workspace/conversationFileScope'

export const resolveCliRuntimeWorkingPath = (
  runtimeRoot: string,
  workingDirectory = '/',
): string => {
  const normalized = normalizeConversationWorkingDirectory(workingDirectory)
  const relative = normalized.replace(/^\/+/, '')
  if (!relative) return runtimeRoot
  const separator = runtimeRoot.includes('\\') ? '\\' : '/'
  const base = /[\\\/]$/u.test(runtimeRoot)
    ? runtimeRoot
    : `${runtimeRoot}${separator}`
  return `${base}${relative.replace(/\//gu, separator)}`
}
