import { sha256Hex } from './searchIdentityHash'

export type ProjectionSource =
  | {
      kind: 'markdown'
      text: string
      signal?: AbortSignal
    }
  | {
      kind: 'pdf'
      pages: Array<{ page: number; text: string }>
      signal?: AbortSignal
    }

export type ProjectionSegment = {
  key: string
  contentHash: string
  occurrenceIndex: number
  text: string
  range:
    | {
        kind: 'lines'
        start: number
        end: number
      }
    | {
        kind: 'pages'
        start: number
        end: number
      }
  rebased?: boolean
}

type SegmentLimit = {
  targetChars: number
  maxChars: number
}

type PendingBlock = {
  lines: string[]
  start: number
  end: number
}

const HEADING_LINE_RE = /^#{1,6}\s+\S/
const DEFAULT_SEGMENT_LIMITS: SegmentLimit = {
  targetChars: 1_800,
  maxChars: 4_000,
}

export function segmentProjectionSource(
  source: ProjectionSource,
): ProjectionSegment[] {
  if (source.kind === 'pdf') {
    return segmentPdfSource(source.pages, DEFAULT_SEGMENT_LIMITS)
  }
  return segmentMarkdownSource(source.text, DEFAULT_SEGMENT_LIMITS)
}

export async function segmentMarkdown(
  text: string,
  limits: SegmentLimit,
): Promise<ProjectionSegment[]> {
  return segmentMarkdownSource(text, limits)
}

export async function segmentPdfPages(
  pages: Array<{ page: number; text: string }>,
  limits: SegmentLimit,
): Promise<ProjectionSegment[]> {
  return segmentPdfSource(pages, limits)
}

export function hashProjectionSegment(text: string): string {
  return sha256Hex(text)
}

export function hashProjectionSource(source: ProjectionSource): string {
  if (source.kind === 'markdown') {
    return sha256Hex(
      JSON.stringify([
        'projection-source-v2',
        'markdown',
        normalizeProjectionNewlines(source.text),
      ]),
    )
  }

  validateProjectionPdfPages(source.pages)
  return sha256Hex(
    JSON.stringify([
      'projection-source-v2',
      'pdf',
      source.pages.map(({ page, text }) => [
        page,
        normalizeProjectionNewlines(text),
      ]),
    ]),
  )
}

export function buildProjectionSegmentKey(
  contentHash: string,
  occurrenceIndex: number,
): string {
  return `${contentHash}:${occurrenceIndex}`
}

function segmentMarkdownSource(
  text: string,
  limits: SegmentLimit,
): ProjectionSegment[] {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const segments: ProjectionSegment[] = []
  const occurrenceIndexByHash = new Map<string, number>()
  let index = 0

  const frontmatter = readLeadingFrontmatter(lines)
  if (frontmatter) {
    pushBlocks(
      segments,
      splitBlockByLength(frontmatter.lines, frontmatter.start, limits),
      'lines',
      occurrenceIndexByHash,
    )
    index = frontmatter.end
  }

  let currentBlock: PendingBlock | null = null
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim().length === 0) {
      if (currentBlock) {
        pushBlocks(
          segments,
          splitBlockByLength(currentBlock.lines, currentBlock.start, limits),
          'lines',
          occurrenceIndexByHash,
        )
        currentBlock = null
      }
      continue
    }

    if (HEADING_LINE_RE.test(line) && currentBlock) {
      pushBlocks(
        segments,
        splitBlockByLength(currentBlock.lines, currentBlock.start, limits),
        'lines',
        occurrenceIndexByHash,
      )
      currentBlock = null
    }

    if (!currentBlock) {
      currentBlock = {
        lines: [line],
        start: index + 1,
        end: index + 1,
      }
      continue
    }

    currentBlock.lines.push(line)
    currentBlock.end = index + 1
  }

  if (currentBlock) {
    pushBlocks(
      segments,
      splitBlockByLength(currentBlock.lines, currentBlock.start, limits),
      'lines',
      occurrenceIndexByHash,
    )
  }

  return segments
}

function segmentPdfSource(
  pages: Array<{ page: number; text: string }>,
  limits: SegmentLimit,
): ProjectionSegment[] {
  const segments: ProjectionSegment[] = []
  const occurrenceIndexByHash = new Map<string, number>()

  for (const page of pages) {
    const text = page.text.replace(/\r\n/g, '\n').trim()
    if (!text) {
      continue
    }
    const blocks = splitBlockByLength([text], page.page, limits)
    pushBlocks(segments, blocks, 'pages', occurrenceIndexByHash, page.page)
  }

  return segments
}

function splitBlockByLength(
  lines: string[],
  startLine: number,
  limits: SegmentLimit,
): PendingBlock[] {
  const chunks: PendingBlock[] = []
  let chunkLines: string[] = []
  let chunkStart = startLine
  let currentLength = 0

  const flush = (endLine: number) => {
    if (chunkLines.length === 0) {
      return
    }
    chunks.push({
      lines: [...chunkLines],
      start: chunkStart,
      end: endLine,
    })
    chunkLines = []
    currentLength = 0
  }

  for (let offset = 0; offset < lines.length; offset += 1) {
    const line = lines[offset] ?? ''
    const lineLength = line.length

    if (lineLength > limits.maxChars) {
      flush(startLine + offset - 1)

      for (const chunk of splitOversizedText(line, limits.maxChars)) {
        chunks.push({
          lines: [chunk],
          start: startLine + offset,
          end: startLine + offset,
        })
      }

      chunkStart = startLine + offset + 1
      continue
    }

    const nextLength =
      currentLength === 0 ? lineLength : currentLength + 1 + lineLength

    if (chunkLines.length > 0 && nextLength > limits.maxChars) {
      flush(startLine + offset - 1)
      chunkStart = startLine + offset
    }

    chunkLines.push(line)
    currentLength =
      currentLength === 0 ? lineLength : currentLength + 1 + lineLength

    if (currentLength >= limits.targetChars && chunkLines.length > 0) {
      flush(startLine + offset)
      chunkStart = startLine + offset + 1
    }
  }

  flush(startLine + lines.length - 1)
  return chunks
}

function splitOversizedText(text: string, maxChars: number): string[] {
  const chunks: string[] = []

  for (let start = 0; start < text.length; start += maxChars) {
    chunks.push(text.slice(start, start + maxChars))
  }

  return chunks
}

function pushBlocks(
  segments: ProjectionSegment[],
  blocks: PendingBlock[],
  kind: 'lines' | 'pages',
  occurrenceIndexByHash: Map<string, number>,
  fixedPage?: number,
): void {
  for (const block of blocks) {
    const text = block.lines.join('\n').trim()
    if (!text) {
      continue
    }
    const contentHash = hashProjectionSegment(text)
    const occurrenceIndex = occurrenceIndexByHash.get(contentHash) ?? 0
    occurrenceIndexByHash.set(contentHash, occurrenceIndex + 1)
    segments.push({
      key: buildProjectionSegmentKey(contentHash, occurrenceIndex),
      contentHash,
      occurrenceIndex,
      text,
      range:
        kind === 'pages'
          ? {
              kind,
              start: fixedPage ?? block.start,
              end: fixedPage ?? block.end,
            }
          : {
              kind,
              start: block.start,
              end: block.end,
            },
    })
  }
}

function readLeadingFrontmatter(lines: string[]): PendingBlock | null {
  if (lines[0]?.trim() !== '---') {
    return null
  }

  const closingIndex = lines.findIndex(
    (line, index) => index >= 1 && line.trim() === '---',
  )
  if (closingIndex === -1) {
    return null
  }

  return {
    lines: lines.slice(0, closingIndex + 1),
    start: 1,
    end: closingIndex + 1,
  }
}

function normalizeProjectionNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function validateProjectionPdfPages(
  pages: Array<{ page: number; text: string }>,
): void {
  let previousPage = 0
  for (const { page } of pages) {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new Error(
        'PDF page numbers must be positive safe integers before hashing',
      )
    }
    if (page <= previousPage) {
      throw new Error(
        'PDF page numbers must be strictly increasing and unique before hashing',
      )
    }
    previousPage = page
  }
}
