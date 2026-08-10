import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'

/**
 * A chunk emitted by the markdown-aware splitter. `startLine`/`endLine` are
 * 1-based and refer to the original source text.
 *
 * For oversized code blocks and tables that are sub-split with the
 * "soft-preserve" strategy, every sub-chunk repeats the opening/closing fence
 * or the header/alignment rows so each chunk is self-contained parseable
 * markdown. The `startLine`/`endLine` of those sub-chunks therefore cover the
 * original block's full line range (the duplicated fence/header rows map back
 * to the original block, not synthetic lines).
 */
export type SplitChunk = {
  content: string
  startLine: number
  endLine: number
}

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

type Block =
  | { kind: 'code'; lang: string; body: string; start: number; end: number }
  | {
      kind: 'table'
      header: string
      align: string
      rows: string[]
      start: number
      end: number
    }
  | {
      kind: 'heading'
      level: HeadingLevel
      text: string
      start: number
      end: number
    }
  | { kind: 'prose'; text: string; start: number; end: number }

const FENCE_OPEN_RE = /^\s{0,3}(```|~~~)(.*)$/
const FENCE_CLOSE_RE = /^\s{0,3}(```|~~~)\s*$/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
// GFM table row: contains at least one `|`. Outer pipes are optional.
const TABLE_ROW_RE = /^\s{0,3}.*\|.*$/
// Alignment row: only pipes, dashes, colons, spaces — and at least one dash.
const TABLE_ALIGN_RE = /^\s*[:|\s-]+$/

function isTableAlignment(line: string): boolean {
  return TABLE_ALIGN_RE.test(line) && line.includes('-')
}

const JOIN_SEP = '\n\n'

/**
 * Separators used for prose fallback splitting. Extends langchain's markdown
 * preset with `\n# ` (H1 boundary, which the preset omits) and drops
 * `"```\n\n"` (unreliable — code blocks are now handled structurally by the
 * tokenizer, so prose fallback never sees fenced code).
 */
const PROSE_SEPARATORS = [
  '\n# ',
  '\n## ',
  '\n### ',
  '\n#### ',
  '\n##### ',
  '\n###### ',
  '\n\n',
  '\n',
  ' ',
  '',
]

function tokenize(text: string): Block[] {
  // Normalize CRLF / lone CR to LF so line numbering and regex anchors stay
  // well-behaved on Windows-authored notes.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const lineNo = i + 1

    if (line.trim() === '') {
      i++
      continue
    }

    // Fenced code block (``` or ~~~). 4-space indented code is not recognized
    // structurally — it falls through to prose.
    const fenceOpen = FENCE_OPEN_RE.exec(line)
    if (fenceOpen) {
      const lang = fenceOpen[2].trim()
      const start = lineNo
      const bodyLines: string[] = []
      i++
      let closed = false
      while (i < lines.length) {
        const bodyLine = lines[i]
        if (FENCE_CLOSE_RE.exec(bodyLine)) {
          blocks.push({
            kind: 'code',
            lang,
            body: bodyLines.join('\n'),
            start,
            end: i + 1,
          })
          i++
          closed = true
          break
        }
        bodyLines.push(bodyLine)
        i++
      }
      if (!closed) {
        blocks.push({
          kind: 'code',
          lang,
          body: bodyLines.join('\n'),
          start,
          end: lines.length,
        })
      }
      continue
    }

    // GFM pipe table: a row containing `|` followed by an alignment row.
    if (
      TABLE_ROW_RE.test(line) &&
      i + 1 < lines.length &&
      isTableAlignment(lines[i + 1])
    ) {
      const start = lineNo
      const header = line
      const align = lines[i + 1]
      const rows: string[] = []
      i += 2
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        rows.push(lines[i])
        i++
      }
      blocks.push({ kind: 'table', header, align, rows, start, end: i })
      continue
    }

    // ATX heading.
    const headingMatch = HEADING_RE.exec(line)
    if (headingMatch) {
      const level = headingMatch[1].length as HeadingLevel
      blocks.push({
        kind: 'heading',
        level,
        text: headingMatch[2],
        start: lineNo,
        end: lineNo,
      })
      i++
      continue
    }

    // Prose: accumulate non-blank lines until a blank line, a fence open, or
    // the start of a table. Real-world notes often omit blank lines between
    // prose and the next structural block, so we must stop here rather than
    // swallowing the fence/header row into the prose.
    const start = lineNo
    const proseLines: string[] = [line]
    i++
    while (i < lines.length) {
      const nextLine = lines[i]
      if (nextLine.trim() === '') break
      if (FENCE_OPEN_RE.test(nextLine)) break
      if (
        TABLE_ROW_RE.test(nextLine) &&
        i + 1 < lines.length &&
        isTableAlignment(lines[i + 1])
      ) {
        break
      }
      // A heading immediately after prose (no blank line) also ends prose.
      if (HEADING_RE.test(nextLine)) break
      proseLines.push(nextLine)
      i++
    }
    blocks.push({ kind: 'prose', text: proseLines.join('\n'), start, end: i })
  }

  return blocks
}

function renderHeading(b: Extract<Block, { kind: 'heading' }>): string {
  return '#'.repeat(b.level) + ' ' + b.text
}

function renderCode(b: Extract<Block, { kind: 'code' }>): string {
  return '```' + b.lang + '\n' + b.body + '\n```'
}

function renderTable(b: Extract<Block, { kind: 'table' }>): string {
  return [b.header, b.align, ...b.rows].join('\n')
}

function renderBlockText(b: Block): string {
  switch (b.kind) {
    case 'heading':
      return renderHeading(b)
    case 'code':
      return renderCode(b)
    case 'table':
      return renderTable(b)
    case 'prose':
      return b.text
  }
}

/**
 * Sub-split an oversized fenced code block. Each sub-chunk repeats the
 * opening fence (with language tag) and closing fence so it stays
 * self-contained. Overlap is forced to 0 — duplicating code lines across
 * chunks would harm retrieval more than it helps.
 */
function subSplitCode(
  b: Extract<Block, { kind: 'code' }>,
  chunkSize: number,
): SplitChunk[] {
  const open = '```' + b.lang + '\n'
  const close = '\n```'
  const targetBody = Math.max(50, chunkSize - open.length - close.length)

  const lines = b.body.split('\n')
  const groups: string[] = []
  let cur: string[] = []
  let curLen = 0
  for (const ln of lines) {
    const add = ln.length + (cur.length > 0 ? 1 : 0)
    if (curLen + add > targetBody && cur.length > 0) {
      groups.push(cur.join('\n'))
      cur = [ln]
      curLen = ln.length
    } else {
      cur.push(ln)
      curLen += add
    }
  }
  if (cur.length > 0) groups.push(cur.join('\n'))

  const chunks: SplitChunk[] = []
  for (const group of groups) {
    if (group.length <= targetBody) {
      chunks.push({
        content: open + group + close,
        startLine: b.start,
        endLine: b.end,
      })
    } else {
      // Single line exceeds targetBody — hard-break by slicing. Last resort:
      // duplicating fence rows keeps each slice a valid (if partial) code block.
      for (let j = 0; j < group.length; j += targetBody) {
        chunks.push({
          content: open + group.slice(j, j + targetBody) + close,
          startLine: b.start,
          endLine: b.end,
        })
      }
    }
  }
  return chunks
}

/**
 * Sub-split an oversized table. Each sub-chunk after the first repeats the
 * header and alignment rows so it stays a valid GFM table.
 */
function subSplitTable(
  b: Extract<Block, { kind: 'table' }>,
  chunkSize: number,
): SplitChunk[] {
  const prefix = b.header + '\n' + b.align + '\n'
  const targetRows = Math.max(50, chunkSize - prefix.length)

  const chunks: SplitChunk[] = []
  let cur: string[] = []
  let curLen = 0
  for (const row of b.rows) {
    const add = row.length + (cur.length > 0 ? 1 : 0)
    if (curLen + add > targetRows && cur.length > 0) {
      chunks.push({
        content: prefix + cur.join('\n'),
        startLine: b.start,
        endLine: b.end,
      })
      cur = [row]
      curLen = row.length
    } else {
      cur.push(row)
      curLen += add
    }
  }
  if (cur.length > 0) {
    chunks.push({
      content: prefix + cur.join('\n'),
      startLine: b.start,
      endLine: b.end,
    })
  }
  return chunks
}

/**
 * Sub-split an oversized prose block via langchain's
 * `RecursiveCharacterTextSplitter` with `PROSE_SEPARATORS` (adds H1). Line
 * numbers come from langchain's `metadata.loc.lines.from/to`, offset by the
 * prose block's starting line. If `headingPrefix` is given, it is prepended to
 * the first sub-chunk (heading + body kept together).
 */
async function subSplitProse(
  b: Extract<Block, { kind: 'prose' }>,
  chunkSize: number,
  chunkOverlap: number,
  headingPrefix?: string,
  headingStart?: number,
): Promise<SplitChunk[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: PROSE_SEPARATORS,
  })
  const docs = await splitter.createDocuments([b.text])

  const chunks: SplitChunk[] = []
  for (let idx = 0; idx < docs.length; idx++) {
    const doc = docs[idx]
    const from = (doc.metadata as { loc?: { lines?: { from?: number } } }).loc
      ?.lines?.from
    const to = (doc.metadata as { loc?: { lines?: { to?: number } } }).loc
      ?.lines?.to
    const relFrom = typeof from === 'number' ? from : 1
    const relTo = typeof to === 'number' ? to : relFrom
    const absStart = b.start + relFrom - 1
    const absEnd = b.start + relTo - 1

    if (idx === 0 && headingPrefix) {
      chunks.push({
        content: headingPrefix + doc.pageContent,
        startLine: Math.min(headingStart ?? b.start, absStart),
        endLine: absEnd,
      })
    } else {
      chunks.push({
        content: doc.pageContent,
        startLine: absStart,
        endLine: absEnd,
      })
    }
  }
  return chunks
}

type BufEntry = { text: string; start: number; end: number }

function bufLen(entries: BufEntry[]): number {
  if (entries.length === 0) return 0
  let total = 0
  for (const e of entries) total += e.text.length
  return total + (entries.length - 1) * JOIN_SEP.length
}

/**
 * Split markdown `text` into chunks of at most `chunkSize` characters
 * (soft limit — structural elements shorter than `chunkSize` are never split).
 * `chunkOverlap` is honored between prose chunks; structural sub-splits use
 * 0 overlap to avoid duplicating fence/header rows.
 */
export async function splitMarkdownIntoChunks(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
): Promise<SplitChunk[]> {
  const blocks = tokenize(text)
  const result: SplitChunk[] = []
  let buf: BufEntry[] = []

  const flush = () => {
    if (buf.length === 0) return
    result.push({
      content: buf.map((e) => e.text).join(JOIN_SEP),
      startLine: buf[0].start,
      endLine: buf[buf.length - 1].end,
    })
    if (chunkOverlap > 0 && buf.length > 0) {
      const last = buf[buf.length - 1]
      if (last.text.length <= chunkOverlap) {
        buf = [last]
        return
      }
    }
    buf = []
  }

  const tryAdd = (entry: BufEntry) => {
    if (
      buf.length > 0 &&
      bufLen(buf) + JOIN_SEP.length + entry.text.length > chunkSize
    ) {
      flush()
    }
    buf.push(entry)
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]

    // Heading pairing: never emit a heading alone. Look ahead and pair with
    // the next block when possible.
    if (block.kind === 'heading' && i + 1 < blocks.length) {
      const next = blocks[i + 1]
      const headingText = renderHeading(block)
      const nextText = renderBlockText(next)
      const combined = headingText + JOIN_SEP + nextText

      if (combined.length <= chunkSize) {
        tryAdd({ text: combined, start: block.start, end: next.end })
        i++
        continue
      }

      // Combined oversized: flush, then sub-split with heading attached to
      // the first sub-chunk.
      flush()
      if (next.kind === 'prose') {
        result.push(
          ...(await subSplitProse(
            next,
            chunkSize,
            chunkOverlap,
            headingText + JOIN_SEP,
            block.start,
          )),
        )
      } else if (next.kind === 'code') {
        const subs = subSplitCode(next, chunkSize)
        if (subs.length > 0) {
          result.push({
            content: headingText + JOIN_SEP + subs[0].content,
            startLine: block.start,
            endLine: subs[0].endLine,
          })
          result.push(...subs.slice(1))
        } else {
          result.push({
            content: headingText + JOIN_SEP + '```' + next.lang + '\n\n```',
            startLine: block.start,
            endLine: next.end,
          })
        }
      } else if (next.kind === 'table') {
        const subs = subSplitTable(next, chunkSize)
        if (subs.length > 0) {
          result.push({
            content: headingText + JOIN_SEP + subs[0].content,
            startLine: block.start,
            endLine: subs[0].endLine,
          })
          result.push(...subs.slice(1))
        } else {
          result.push({
            content: headingText + JOIN_SEP + next.header + '\n' + next.align,
            startLine: block.start,
            endLine: next.end,
          })
        }
      }
      i++
      continue
    }

    // Non-heading block, or heading at end of document with no following block.
    const rendered = renderBlockText(block)
    if (rendered.length > chunkSize) {
      flush()
      if (block.kind === 'code') {
        result.push(...subSplitCode(block, chunkSize))
      } else if (block.kind === 'table') {
        result.push(...subSplitTable(block, chunkSize))
      } else if (block.kind === 'prose') {
        result.push(...(await subSplitProse(block, chunkSize, chunkOverlap)))
      } else {
        // Heading with no following block (rare, end of doc): emit alone.
        result.push({
          content: rendered,
          startLine: block.start,
          endLine: block.end,
        })
      }
    } else {
      tryAdd({ text: rendered, start: block.start, end: block.end })
    }
  }
  flush()

  return result
}
