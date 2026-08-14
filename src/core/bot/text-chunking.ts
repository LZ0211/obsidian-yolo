/**
 * Shared long-reply chunking for platform adapters (B4): every platform
 * enforces a per-message length cap (`PlatformCapabilities.maxMessageLength`),
 * and replies longer than that must be split into multiple sends instead of
 * being rejected by the platform API or silently truncated. Splits at the
 * last newline (then last space) within the limit so words/paragraphs aren't
 * cut mid-way when avoidable — same semantics as the Telegram adapter's
 * original `splitTextAtBoundaries`.
 */
export function splitTextAtBoundaries(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLen)
    if (splitAt <= 0) splitAt = maxLen
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\s+/, '')
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}
