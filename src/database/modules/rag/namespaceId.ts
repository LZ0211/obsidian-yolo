import { sha256HexSync } from '../../../utils/common/content-hash'

import type { VectorNamespace } from './VectorStore'

function normalizeNamespaceModel(model: string): string {
  const lastSegment = model
    .trim()
    .replace(/[\\/]+$/g, '')
    .split(/[\\/]+/)
    .filter((segment) => segment.trim().length > 0)
    .pop()

  const normalized = (lastSegment ?? model)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')

  return normalized || 'embedding-model'
}

function normalizeCorpus(corpus: string | undefined): string | null {
  const normalized = corpus
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')

  return normalized || null
}

function normalizeEndpointIdentity(
  endpoint: string | undefined,
): string | null {
  const value = endpoint?.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    if (
      (url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443')
    ) {
      url.port = ''
    }
    url.pathname = url.pathname.replace(/\/+$/g, '') || '/'
    return url.toString().replace(/\/$/u, '')
  } catch {
    return value.replace(/\/+$/g, '')
  }
}

export function vectorNamespaceId(namespace: VectorNamespace): string {
  const identity = [
    namespace.providerIdentity?.trim(),
    normalizeEndpointIdentity(namespace.endpointIdentity ?? undefined),
  ]
    .filter((value): value is string => Boolean(value))
    .join('\u0000')
  const identitySuffix = identity ? `-i${sha256HexPrefix12(identity)}` : ''
  const baseId = `${normalizeNamespaceModel(namespace.model)}-d${namespace.dimension}${identitySuffix}`
  const encodedId =
    namespace.embeddingEncoding == null
      ? baseId
      : `${baseId}-${sha256HexPrefix12(namespace.embeddingEncoding)}`
  const corpus = normalizeCorpus(namespace.corpus)

  return corpus ? `${corpus}--${encodedId}` : encodedId
}

/**
 * 引入 provider/endpoint identity 之前（audit 修复 653c8e86d）的 namespace id
 * 算法。identity 后缀加入后旧索引的存储位置整体切换，升级用户需要用旧算法
 * 找到历史数据做一次性迁移（见 SqliteVectorStore / ShardedVectorStore）。
 */
export function legacyVectorNamespaceId(namespace: VectorNamespace): string {
  const baseId = `${normalizeNamespaceModel(namespace.model)}-d${namespace.dimension}`
  const encodedId =
    namespace.embeddingEncoding == null
      ? baseId
      : `${baseId}-${sha256HexPrefix12(namespace.embeddingEncoding)}`
  const corpus = normalizeCorpus(namespace.corpus)

  return corpus ? `${corpus}--${encodedId}` : encodedId
}

function sha256HexPrefix12(value: string): string {
  return sha256HexSync(value).slice(0, 12)
}
