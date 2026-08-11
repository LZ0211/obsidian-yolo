/** First 16 hex chars of SHA-256 (sufficient for chunk dedup). */
export async function sha256HexPrefix16(text: string): Promise<string> {
  return (await sha256Hex(text)).slice(0, 16)
}

/** Full SHA-256 hex digest. */
export async function sha256Hex(text: string): Promise<string> {
  const enc = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest('SHA-256', enc)
  const hex = Array.from(new Uint8Array(buf), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  return hex
}
