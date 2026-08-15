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

export function vectorNamespaceId(namespace: VectorNamespace): string {
  // 命名空间只按模型+维度（+编码/语料）键控：同一模型的嵌入向量跨
  // provider/endpoint 兼容，endpoint 参与键值只会让换服务器/改地址时
  // 索引表"看起来全空"，导致每次更新索引都全量重建。
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
