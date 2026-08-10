import { createHash } from 'node:crypto'

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
  const baseId = `${normalizeNamespaceModel(namespace.model)}-d${namespace.dimension}`
  const encodedId =
    namespace.embeddingEncoding == null
      ? baseId
      : `${baseId}-${sha256HexPrefix12(namespace.embeddingEncoding)}`
  const corpus = normalizeCorpus(namespace.corpus)

  return corpus ? `${corpus}--${encodedId}` : encodedId
}

function sha256HexPrefix12(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}
