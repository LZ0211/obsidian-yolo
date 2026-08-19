import type { DiffBlock } from '../../../utils/chat/diff'
import { createLineDiffBlocks } from '../../../utils/chat/diff'

/**
 * Flat line-oriented diff for the selection-rewrite review overlay:
 * `equal` lines pass through unchanged, `del` shows the original text with a
 * strikethrough, `ins` shows the rewritten text highlighted. Derived from
 * `createLineDiffBlocks` (the shared markdown diff engine), so the review
 * view and the fs_edit review view use the same diff semantics.
 */
export type ReviewDiffLine =
  | { kind: 'equal'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'ins'; text: string }

const splitLines = (text: string): string[] =>
  text.length === 0 ? [] : text.split('\n')

const appendBlock = (lines: ReviewDiffLine[], block: DiffBlock): void => {
  if (block.type === 'unchanged') {
    for (const line of splitLines(block.value)) {
      lines.push({ kind: 'equal', text: line })
    }
    return
  }
  if (block.originalValue) {
    for (const line of splitLines(block.originalValue)) {
      lines.push({ kind: 'del', text: line })
    }
  }
  if (block.modifiedValue) {
    for (const line of splitLines(block.modifiedValue)) {
      lines.push({ kind: 'ins', text: line })
    }
  }
}

export function buildReviewDiff(
  originalText: string,
  rewrittenText: string,
): ReviewDiffLine[] {
  const lines: ReviewDiffLine[] = []
  for (const block of createLineDiffBlocks(originalText, rewrittenText)) {
    appendBlock(lines, block)
  }
  return lines
}
